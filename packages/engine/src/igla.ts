import { angDiff, dirOf, losOf, type Vec3 } from './ballistics';
import { getConfig, weatherFx, type Config } from './config';
import type { GunPart } from './gunscore';
import { buildGrid, segBlocked, type PatrolEngine, type PatrolWorld } from './patrol';
import type { TimeOfDay, Weather } from './types';
import { clamp, mulberry } from './util';

/**
 * Igla (9K38-type MANPADS) drill on foot: the trainee is the gunner, walking the town of the urban patrol in first person.
 * The air defence net calls contacts by bearing; the gunner finds clear sky, shoulders the launcher, identifies each
 * contact through the sight, and spends a missile only on a target worth one (an ISR drone, a Shahed-type swarm drone, a
 * loitering munition, a jet drone, the large UAV), never on an FPV quadcopter (take cover from it), a friendly, a civil
 * drone or a bird.
 * The launcher works as the real one does in outline: a battery-coolant unit (BCU) powers the electronics and cools the
 * seeker (ready in about 5 s, spent about 35 s after switching on); the infrared seeker must see the target inside its
 * small field of view and lock (steady tone and light) before the trigger will launch (the launch interlock); the gunner
 * then lifts the launcher a few degrees above and ahead of the target (super-elevation and lead) and fires. The missile
 * flies itself (fire and forget, proportional navigation). Reload: unlatch the gripstock from the spent tube, clamp it
 * on a fresh sealed tube, screw on a fresh BCU.
 * Separate from the gun drills and the patrol (own records, own rules I1–I9). Deterministic: a drill is fully defined by
 * its config, its world and its time-stamped action log. Engine frame: x east, y north, z up (metres); bearings
 * clockwise from north. All values are training values, not equipment specifications.
 */
export const IGLA = {
  note: 'Training values, not equipment specifications. DSSC to confirm.',
  /** Gunner: eye height, walking, running and shouldered speeds (m/s), body radius (m), time to shoulder (s). */
  eyeM: 1.65, walk: 1.5, run: 4.2, aimWalk: 0.6, radius: 0.35, raiseSec: 0.9,
  /** Battery-coolant unit: seeker ready after switching on, spent after; time to screw one on; time to move the gripstock to a fresh tube. */
  readySec: 5, bcuSec: 35, bcuFitSec: 4, tubeSwapSec: 12, reloadStdSec: 25,
  /** Seeker: field of view (half angle) to acquire, gimbal limit once locked (from the launcher axis), seconds to lock; delay from trigger to launch. */
  seekConeDeg: 2.5, gimbalDeg: 12, lockSec: 0.6, launchDelaySec: 0.8,
  /** Engagement envelope (slant range, height) and the super-elevation band (degrees above the line of sight at launch). */
  minRangeM: 500, maxRangeM: 5200, maxAltM: 3500, superElDeg: [2, 10] as [number, number],
  /** Missile: ejection speed and time, boost, top speed, motor time, coast deceleration, turn limit, navigation constant,
   *  seeker gimbal in flight, arming time, self-destruct time. */
  ejectMs: 30, ejectSec: 0.25, boostAcc: 300, vMax: 570, burnSec: 6, coastDecel: 15, aMaxG: 16, navN: 4, missileGimbalDeg: 40, armSec: 1.0, flightSec: 17,
  /** Seeing: through the sight (magnified, and thermal at night) contacts are seen this much further; night without it. */
  scopeMag: 2, nightNaked: 0.3, nightThermal: 0.9,
  /** Issue: sealed tubes (one on the gripstock) and BCUs (one fitted). */
  tubes: 3, bcus: 4,
  /** Infrared range factor by weather. */
  irWeather: { clear: 1, rain: 0.7, fog: 0.5, dust: 0.6 } as Record<string, number>,
  /** Per drone type: span (m, how far it is seen and how big a target), seeker lock range (m), and whether it is worth a
   *  missile (high), not worth one (low: an FPV or a small quad is for the guns, jammers and cover), or never to be engaged. */
  types: {
    recon: { spanM: 0.7, irM: 1500, value: 'high' }, swarm: { spanM: 2.5, irM: 3500, value: 'high' }, loiter: { spanM: 2.5, irM: 2500, value: 'high' },
    jetOwa: { spanM: 3, irM: 5000, value: 'high' }, vtol: { spanM: 3, irM: 2500, value: 'high' }, tacIsr: { spanM: 3, irM: 2500, value: 'high' },
    male: { spanM: 12, irM: 5000, value: 'high' }, fpv: { spanM: 0.3, irM: 600, value: 'low' }, fibre: { spanM: 0.3, irM: 600, value: 'low' },
    dropper: { spanM: 0.9, irM: 900, value: 'low' }, aiStrike: { spanM: 1, irM: 1500, value: 'low' },
    friendly: { spanM: 4, irM: 3000, value: 'never' }, civil: { spanM: 0.5, irM: 700, value: 'never' }, bird: { spanM: 0.8, irM: 300, value: 'never' },
  } as Record<string, { spanM: number; irM: number; value: 'high' | 'low' | 'never' }>,
};
export type IglaValue = 'high' | 'low' | 'never';
export interface IglaCfg {
  seed: number; time: TimeOfDay; weather?: Weather; difficulty: number;
  /** Time limit (s); missing = 300. */ maxSec?: number;
  /** Sealed tubes issued (one on the gripstock); missing = 3. */ tubes?: number;
  /** BCUs issued (one fitted); missing = 4. */ bcus?: number;
}
export type IglaActionKind = 'move' | 'look' | 'raise' | 'power' | 'trig' | 'bcu' | 'reload' | 'ident';
export interface IglaAction { tick: number; k: IglaActionKind; f?: number; s?: number; run?: boolean; az?: number; el?: number; on?: boolean; cid?: number; cls?: string; }
export type IGoal = 'transit' | 'orbit' | 'hover' | 'asset' | 'hunt' | 'wander';
export interface ISpawn { type: string; t: number; x: number; y: number; alt: number; goal: IGoal; gx: number; gy: number; gz: number; orbitR: number; }
export interface ITarget {
  id: number; type: string; hostile: boolean; value: IglaValue; goal: IGoal; spawnTick: number; p: Vec3; prev: Vec3; v: Vec3;
  gx: number; gy: number; gz: number; orbitR: number; /** Seconds orbiting or hovering over the area. */ aux: number;
  state: 'live' | 'destroyed' | 'leaked' | 'gone'; endTick: number | null; leakKind?: 'struck' | 'asset' | 'observed' | 'crashed' | 'left';
}
export interface IMissile { id: number; cid: number | null; tick0: number; p: Vec3; prev: Vec3; v: Vec3; guided: boolean; state: 'fly' | 'hit' | 'miss'; end: number | null; why?: string; minD: number; }
export interface ILaunch { tick: number; cid: number; type: string; value: IglaValue; ident: string | null; range: number; alt: number; elOff: number; azOff: number; azRate: number; leadOk: boolean; superOk: boolean; envOk: boolean; missile: number; }
export interface IEvent { tick: number; k: string; cid?: number; n?: number; text?: string; }
export type Seeker = 'off' | 'cooling' | 'search' | 'acq' | 'lock';
export interface IglaEngine {
  C: Config; cfg: IglaCfg; W: PatrolWorld; tick: number; dt: number; grid: PatrolEngine['grid'];
  sol: { x: number; y: number; az: number; el: number; f: number; s: number; run: boolean; running: boolean; raise: number; wantRaise: boolean; odo: number; struck: boolean; fatigue: number };
  lch: { tube: 'live' | 'spent'; bcu: 'none' | 'fitted' | 'active' | 'spent'; bcuOn: number | null; tubes: number; bcus: number; busy: { k: 'reload' | 'bcu'; until: number } | null;
    seeker: Seeker; lockCid: number | null; lockStart: number | null; trigAt: number | null };
  spawns: ISpawn[]; next: number; targets: ITarget[]; missiles: IMissile[]; launches: ILaunch[]; ev: IEvent[];
  /** First tick each contact could be seen through the sight, and seconds it could be seen. */ seen: Record<number, number>; seenSec: Record<number, number>;
  /** Consecutive ticks each contact has been in sight as the gunner is now (shouldered or not). */ vis: Record<number, number>;
  /** Seconds each contact was engageable: in sight through the sight, inside the envelope and inside the seeker's range. */ engSec: Record<number, number>;
  idents: { tick: number; cid: number; cls: string }[]; bcuWasted: number; reloads: { launch: number; ready: number | null }[];
}

const sec = (E: { dt: number }, s: number) => Math.round(s / E.dt);
const D2R = Math.PI / 180;
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const angBetween = (a: Vec3, b: Vec3) => Math.acos(clamp(dot(a, b) / ((len(a) * len(b)) || 1), -1, 1)) / D2R;

export const defaultIglaCfg = (o: Partial<IglaCfg> = {}): IglaCfg => ({ seed: 1, time: 'day', difficulty: 3, ...o });
export const iglaType = (type: string) => IGLA.types[type] ?? { spanM: 1, irM: 1500, value: 'low' as IglaValue };
export const iEye = (E: IglaEngine): Vec3 => [E.sol.x, E.sol.y, IGLA.eyeM];
/** Target position at a fraction of the current tick (for drawing). */
export const iTargetAt = (T: ITarget, f: number): Vec3 => [T.prev[0] + (T.p[0] - T.prev[0]) * f, T.prev[1] + (T.p[1] - T.prev[1]) * f, T.prev[2] + (T.p[2] - T.prev[2]) * f];
export const iIdentOf = (E: IglaEngine, cid: number): string | null => { for (let i = E.idents.length - 1; i >= 0; i--) if (E.idents[i].cid === cid) return E.idents[i].cls; return null; };
const tgt = (E: IglaEngine, id: number | null | undefined) => (id == null ? undefined : E.targets.find((t) => t.id === id));

// ---------- seeing and the seeker ----------
/** How far the gunner sees this contact: by eye, or through the sight (magnified; thermal at night). */
export function iSeeRangeM(E: IglaEngine, T: ITarget, scoped: boolean): number {
  const night = E.cfg.time === 'night', wx = weatherFx(E.C, E.cfg.weather);
  return Math.min(9000, iglaType(T.type).spanM * 1100 * (scoped ? IGLA.scopeMag : 1) * (night ? (scoped ? IGLA.nightThermal : IGLA.nightNaked) : 1) * wx.camera);
}
export const iClear = (E: IglaEngine, p: Vec3): boolean => segBlocked(E, iEye(E), p, false) == null;
/** Can the gunner see this contact now (shouldered: through the sight)? */
export function iVisible(E: IglaEngine, T: ITarget, scoped = E.sol.raise >= 1): boolean {
  if (T.state !== 'live') return false;
  const L = losOf(sub(T.p, iEye(E)));
  return L.range <= iSeeRangeM(E, T, scoped) && L.el > -3 && iClear(E, T.p);
}
/** Seeker lock range on this contact (its heat, the weather). */
export const iIrRangeM = (E: IglaEngine, T: ITarget): number => iglaType(T.type).irM * (IGLA.irWeather[E.cfg.weather ?? 'clear'] ?? 1);
export const iInEnvelope = (E: IglaEngine, T: ITarget): boolean => { const r = len(sub(T.p, iEye(E))); return r >= IGLA.minRangeM && r <= IGLA.maxRangeM && T.p[2] <= IGLA.maxAltM; };
/** Angle (deg) between the launcher axis and the line to a point. */
export const iOffBore = (E: IglaEngine, p: Vec3): number => angBetween(dirOf(E.sol.az, E.sol.el), sub(p, iEye(E)));
/** Is the launch line clear for the first 60 m (no wall, fence or building in front of the tube)? */
export const iLaunchClear = (E: IglaEngine): boolean => segBlocked(E, iEye(E), add(iEye(E), dirOf(E.sol.az, E.sol.el), 60)) == null;
/** BCU seconds left (null when not switched on). */
export const iBcuLeft = (E: IglaEngine): number | null => (E.lch.bcu === 'active' && E.lch.bcuOn != null ? Math.max(0, IGLA.bcuSec - (E.tick - E.lch.bcuOn) * E.dt) : null);

// ---------- world: walking ----------
/** Is a gunner standing here inside a building, wall or post, or outside the play area? */
export function iBlocked(E: IglaEngine, x: number, y: number): boolean {
  const G = E.grid, W = E.W, r = IGLA.radius;
  if (Math.abs(x - W.centre[0]) > W.half - 2 || Math.abs(y - W.centre[1]) > W.half - 2) return true;
  const i = Math.floor((x - G.x0) / G.cell), j = Math.floor((y - G.y0) / G.cell);
  for (let jj = j - 1; jj <= j + 1; jj++) for (let ii = i - 1; ii <= i + 1; ii++) {
    if (ii < 0 || jj < 0 || ii >= G.n || jj >= G.n) continue;
    for (const k of G.cells[jj * G.n + ii]) {
      if (k >= 0) { const q = G.rects[k]; if (x > q[0] - r && x < q[2] + r && y > q[1] - r && y < q[3] + r) return true; }
      else { const p = G.posts[-1 - k]; if (Math.hypot(p[0] - x, p[1] - y) < p[2] + r) return true; }
    }
  }
  return false;
}
/** How much open sky a spot has: the share of bearings with a clear line 300 m out at 6° elevation. */
function openness(E: IglaEngine, x: number, y: number): number {
  let n = 0; const o: Vec3 = [x, y, IGLA.eyeM];
  for (let az = 0; az < 360; az += 15) { const d = dirOf(az, 6); if (segBlocked(E, o, add(o, d, 300), false) == null) n++; }
  return n / 24;
}

// ---------- scenario ----------
const H2 = (a: number): [number, number] => [Math.sin(a * D2R), Math.cos(a * D2R)];
export function buildIglaScenario(cfg: IglaCfg, start: [number, number], C: Config = getConfig()): ISpawn[] {
  const d = clamp(cfg.difficulty, 1, 6), r = mulberry(cfg.seed * 13 + 101 + d * 7919), T = C.threats.threats, maxSec = cfg.maxSec ?? 300;
  const has = (k: string) => !!T[k];
  const altOf = (k: string) => { const a = T[k].alt ?? [60, 150]; return a[0] + r() * (a[1] - a[0]); };
  const out: ISpawn[] = [];
  const at = (brg: number, dist: number): [number, number] => { const h = H2(brg); return [start[0] + h[0] * dist, start[1] + h[1] * dist]; };
  const mk = (type: string, t: number, goal: IGoal) => {
    const brg = r() * 360, alt = altOf(type);
    if (goal === 'transit') {
      // A straight pass across the area: closest approach c from the gunner, crossing left or right.
      const c = 600 + r() * 1500, D0 = 4500 + r() * 1500, cp = at(brg, c), u = H2(brg + (r() < 0.5 ? 90 : -90) + (r() - 0.5) * 50), L = Math.sqrt(D0 * D0 - c * c);
      out.push({ type, t, x: cp[0] - u[0] * L, y: cp[1] - u[1] * L, alt, goal, gx: cp[0] + u[0] * L, gy: cp[1] + u[1] * L, gz: alt, orbitR: 0 });
    } else if (goal === 'orbit') {
      const c = at(brg, 1500 + r() * 1500), s = at(brg + (r() - 0.5) * 40, 6000);
      out.push({ type, t, x: s[0], y: s[1], alt, goal, gx: c[0], gy: c[1], gz: alt, orbitR: 800 + r() * 700 });
    } else if (goal === 'hover') {
      const c = at(brg, 700 + r() * 400), s = at(brg + (r() - 0.5) * 30, 2600);
      out.push({ type, t, x: s[0], y: s[1], alt, goal, gx: c[0], gy: c[1], gz: alt, orbitR: 0 });
    } else if (goal === 'asset') {
      const s = at(brg, 4500 + r() * 1500);
      out.push({ type, t, x: s[0], y: s[1], alt, goal, gx: 0, gy: 0, gz: 4, orbitR: 0 }); // goal set to a landmark at creation
    } else if (goal === 'hunt') {
      const s = at(brg, 1500 + r() * 500);
      out.push({ type, t, x: s[0], y: s[1], alt: 25 + r() * 20, goal, gx: start[0], gy: start[1], gz: 2, orbitR: 0 });
    } else {
      const c = at(brg, 300 + r() * 600);
      out.push({ type, t, x: c[0] + 200, y: c[1], alt, goal, gx: c[0], gy: c[1], gz: alt, orbitR: 0 });
    }
  };
  // Worth a missile: 2–4 by level, the first early; a Shahed-type swarm comes as a group.
  const pool: [string, IGoal][] = [['recon', 'hover'], ['swarm', 'asset'], ['tacIsr', 'orbit'], ['loiter', 'asset'], ['vtol', 'transit']];
  if (d >= 2) pool.push(['male', 'orbit']);
  if (d >= 3) pool.push(['jetOwa', 'asset']);
  const nHigh = Math.min(4, 2 + Math.floor(d / 2)), span = Math.max(60, maxSec - 110);
  const times = Array.from({ length: nHigh }, (_, i) => (i === 0 ? 8 + r() * 6 : 20 + r() * span)).sort((a, b) => a - b);
  for (const t of times) {
    const [k, g] = pool[Math.floor(r() * pool.length)];
    if (!has(k)) continue;
    if (k === 'swarm') { const n = d >= 5 ? 4 : d >= 3 ? 3 : 2; mk(k, t, g); const s0 = out[out.length - 1]; for (let i = 1; i < n; i++) out.push({ ...s0, t: t + i * 1.5, x: s0.x + (r() - 0.5) * 120, y: s0.y + (r() - 0.5) * 120 }); }
    else mk(k, t, g);
  }
  // Not worth a missile: FPV hunters (take cover), a payload dropper.
  const nFpv = d >= 6 ? 3 : d >= 4 ? 2 : d >= 2 ? 1 : 0;
  for (let i = 0; i < nFpv; i++) mk(r() < 0.5 && has('fibre') ? 'fibre' : 'fpv', 40 + r() * span, 'hunt');
  if (d >= 3 && has('dropper')) mk('dropper', 30 + r() * span, 'wander');
  // Never engage: a friendly aircraft passing through, a civil drone, birds.
  if (has('friendly')) mk('friendly', 25 + r() * span, 'transit');
  if (d >= 2 && has('civil')) mk('civil', 20 + r() * span, 'wander');
  if (has('bird')) for (let i = 0; i < 1 + (d >= 3 ? 1 : 0); i++) mk('bird', 5 + r() * span, 'wander');
  return out.sort((a, b) => a.t - b.t);
}

export function createIgla(cfg: IglaCfg, W: PatrolWorld, C: Config = getConfig()): IglaEngine {
  const r = mulberry(cfg.seed * 41 + 5);
  const E: IglaEngine = {
    C, cfg, W, tick: 0, dt: C.training.sim.dt, grid: buildGrid(W),
    sol: { x: W.centre[0], y: W.centre[1], az: 0, el: 5, f: 0, s: 0, run: false, running: false, raise: 0, wantRaise: false, odo: 0, struck: false, fatigue: 0 },
    lch: { tube: 'live', bcu: 'fitted', bcuOn: null, tubes: (cfg.tubes ?? IGLA.tubes) - 1, bcus: (cfg.bcus ?? IGLA.bcus) - 1, busy: null, seeker: 'off', lockCid: null, lockStart: null, trigAt: null },
    spawns: [], next: 0, targets: [], missiles: [], launches: [], ev: [], seen: {}, seenSec: {}, vis: {}, engSec: {}, idents: [], bcuWasted: 0, reloads: [],
  };
  // Start on a road, at one of the five most open spots of a sample (the gunner may still want to move).
  const cand: { x: number; y: number; o: number }[] = [];
  for (const rd of W.roads) {
    const L = Math.hypot(rd[2] - rd[0], rd[3] - rd[1]);
    for (let s = 10; s < L; s += 30) {
      const x = rd[0] + ((rd[2] - rd[0]) * s) / L, y = rd[1] + ((rd[3] - rd[1]) * s) / L;
      if (Math.abs(x - W.centre[0]) < W.half - 40 && Math.abs(y - W.centre[1]) < W.half - 40 && !iBlocked(E, x, y)) cand.push({ x, y, o: 0 });
    }
  }
  for (const c of cand) c.o = openness(E, c.x, c.y);
  cand.sort((a, b) => b.o - a.o || a.x - b.x || a.y - b.y);
  const pick = cand[Math.floor(r() * Math.min(5, cand.length))];
  if (pick) { E.sol.x = pick.x; E.sol.y = pick.y; }
  E.sol.az = Math.floor(r() * 8) * 45;
  E.spawns = buildIglaScenario(cfg, [E.sol.x, E.sol.y], C);
  return E;
}

function spawn(E: IglaEngine, sp: ISpawn): void {
  const ty = E.C.threats.threats[sp.type], p: Vec3 = [sp.x, sp.y, sp.alt];
  let gx = sp.gx, gy = sp.gy, gz = sp.gz;
  if (sp.goal === 'asset') { const L = E.W.landmarks[E.targets.length % Math.max(1, E.W.landmarks.length)]; gx = L?.x ?? E.W.centre[0]; gy = L?.y ?? E.W.centre[1]; gz = 4; }
  const dx = gx - p[0], dy = gy - p[1], d = Math.hypot(dx, dy) || 1;
  E.targets.push({ id: E.targets.length + 1, type: sp.type, hostile: ty.hostile, value: iglaType(sp.type).value, goal: sp.goal, spawnTick: E.tick, p, prev: [...p] as Vec3,
    v: [(dx / d) * ty.speed, (dy / d) * ty.speed, 0], gx, gy, gz, orbitR: sp.orbitR, aux: 0, state: 'live', endTick: null });
  // The air defence net calls every aircraft it sees (not birds): bearing, range and height, never the type.
  E.ev.push({ tick: E.tick, k: sp.type === 'bird' ? 'spawn' : 'warn', cid: E.targets.length });
}
const end = (E: IglaEngine, T: ITarget, state: ITarget['state'], kind?: ITarget['leakKind']) => {
  T.state = state; T.endTick = E.tick; if (kind) T.leakKind = kind;
  if (E.lch.lockCid === T.id) { E.lch.lockCid = null; E.lch.lockStart = null; E.lch.trigAt = null; }
};

/** Move a drone one tick (turn-rate limited) and settle what it does when it gets where it is going. */
function moveTarget(E: IglaEngine, T: ITarget, t: number): void {
  const ty = E.C.threats.threats[T.type], dt = E.dt, sp = ty.speed, wing = ty.shape === 'wing';
  T.prev = [...T.p] as Vec3;
  let gx = T.gx, gy = T.gy;
  const gz = T.gz;
  if (T.goal === 'hunt') { gx = E.sol.x; gy = E.sol.y; }
  const dx = gx - T.p[0], dy = gy - T.p[1], hd = Math.hypot(dx, dy);
  let want = Math.atan2(dx, dy), speed = sp;
  if (T.goal === 'orbit' && hd < T.orbitR + 60) { want += (Math.PI / 2) * (T.id % 2 ? 1 : -1) * clamp((T.orbitR + 60 - hd) / 120 + 0.7, 0.7, 1); T.aux += dt; }
  if (T.goal === 'hover' && hd < 40) { speed = Math.min(sp, hd * 0.2 + 0.6); T.aux += dt; want += Math.sin(t * 0.4 + T.id); }
  if (T.goal === 'wander') want += 0.6 * Math.sin(t * 0.25 + T.id * 2);
  if (ty.motion === 'weave') want += 0.3 * Math.sin(t * 0.9 + T.id);
  const cur = Math.atan2(T.v[0], T.v[1]), turn = (wing ? 20 : 90) * D2R * dt;
  let da = want - cur; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
  const h = cur + clamp(da, -turn, turn);
  // Height: hold the cruise height, then dive on the goal (the last 70 m for an FPV hunter, 300 m for a strike drone).
  const D = T.goal === 'hunt' ? 70 : 300, diving = (T.goal === 'hunt' || T.goal === 'asset') && hd < D;
  const cruise = T.goal === 'hunt' || T.goal === 'asset' ? T.p[2] : gz, wantZ = diving ? gz + (T.p[2] - gz) * clamp(hd / D, 0, 1) * 0.85 : cruise;
  const vz = clamp((wantZ - T.p[2]) / Math.max(dt, 0.5), -speed * 0.6, speed * 0.4), hs = Math.sqrt(Math.max(0, speed * speed - vz * vz));
  T.v = [Math.sin(h) * hs, Math.cos(h) * hs, vz];
  T.p = [T.p[0] + T.v[0] * dt, T.p[1] + T.v[1] * dt, Math.max(1, T.p[2] + vz * dt)];
  // Outcomes.
  if (T.goal === 'transit' && hd < 120) { end(E, T, 'gone', 'left'); E.ev.push({ tick: E.tick, k: 'left', cid: T.id }); }
  else if ((T.goal === 'orbit' && T.aux > 120) || (T.goal === 'hover' && T.aux > 75)) { end(E, T, T.hostile ? 'leaked' : 'gone', T.hostile ? 'observed' : 'left'); E.ev.push({ tick: E.tick, k: T.hostile ? 'observed' : 'left', cid: T.id }); }
  else if (T.goal === 'asset' && Math.hypot(hd, T.p[2] - gz) < 15) { end(E, T, 'leaked', 'asset'); E.ev.push({ tick: E.tick, k: 'assetHit', cid: T.id }); }
  else if (T.goal === 'hunt' && hd < 70) {
    // Terminal dive on the gunner: the drone must see him. Behind a building, it loses him and flies into the cover.
    const eye = iEye(E);
    if (segBlocked(E, T.p, eye) != null) { end(E, T, 'gone', 'crashed'); E.ev.push({ tick: E.tick, k: 'fpvCrashed', cid: T.id }); }
    else if (len(sub(T.p, eye)) < 3.5) { end(E, T, 'leaked', 'struck'); E.sol.struck = true; E.ev.push({ tick: E.tick, k: 'struck', cid: T.id }); }
  }
}

// ---------- the gunner's actions ----------
function apply(E: IglaEngine, a: IglaAction): void {
  const S = E.sol, L = E.lch, ev = (k: string, o: Partial<IEvent> = {}) => E.ev.push({ tick: E.tick, k, ...o });
  switch (a.k) {
    case 'move': S.f = clamp(a.f ?? 0, -1, 1); S.s = clamp(a.s ?? 0, -1, 1); S.run = !!a.run; break;
    case 'look': S.az = (((a.az ?? S.az) % 360) + 360) % 360; S.el = clamp(a.el ?? S.el, -20, 85); break;
    case 'raise': S.wantRaise = !!a.on; break;
    case 'power':
      if (L.busy) ev('busy');
      else if (L.tube !== 'live') ev('powerFail', { text: 'tube' });
      else if (L.bcu === 'active') ev('powerFail', { text: 'on' });
      else if (L.bcu !== 'fitted') ev('powerFail', { text: 'bcu' });
      else { L.bcu = 'active'; L.bcuOn = E.tick; ev('power'); }
      break;
    case 'trig':
      if (!a.on) break;
      if (L.trigAt != null) break;
      if (L.tube !== 'live') ev('noLaunch', { text: 'tube' });
      else if (S.raise < 1) ev('noLaunch', { text: 'raise' });
      else if (L.seeker !== 'lock') ev('noLaunch', { text: L.seeker });
      else { L.trigAt = E.tick; ev('trigger', { cid: L.lockCid ?? undefined }); }
      break;
    case 'bcu':
      if (L.busy) ev('busy');
      else if (L.tube !== 'live') ev('bcuFail', { text: 'tube' });
      else if (L.bcu === 'fitted' || L.bcu === 'active') ev('bcuFail', { text: 'have' });
      else if (L.bcus <= 0) ev('bcuFail', { text: 'none' });
      else { L.bcus--; L.bcu = 'none'; L.busy = { k: 'bcu', until: E.tick + sec(E, IGLA.bcuFitSec) }; S.wantRaise = false; ev('bcuFit'); }
      break;
    case 'reload':
      if (L.busy) ev('busy');
      else if (L.tube === 'live') ev('reloadFail', { text: 'live' });
      else if (L.tubes <= 0) ev('reloadFail', { text: 'none' });
      else { L.tubes--; L.busy = { k: 'reload', until: E.tick + sec(E, IGLA.tubeSwapSec) }; S.wantRaise = false; ev('tubeSwap'); }
      break;
    case 'ident': {
      const T = tgt(E, a.cid);
      if (!T || !a.cls || T.state !== 'live' || !iVisible(E, T)) { ev('identFail', { cid: a.cid }); break; }
      E.idents.push({ tick: E.tick, cid: T.id, cls: a.cls }); ev('ident', { cid: T.id, text: a.cls });
      break;
    }
  }
}

function launch(E: IglaEngine): void {
  const L = E.lch, S = E.sol, T = tgt(E, L.lockCid)!, eye = iEye(E), rel = sub(T.p, eye), Ls = losOf(rel), L1 = losOf(sub(add(T.p, T.v, 1), eye));
  const azRate = angDiff(L1.az, Ls.az), elOff = S.el - Ls.el, azOff = angDiff(S.az, Ls.az), crossing = Math.abs(azRate) > 0.4;
  const leadOk = crossing ? Math.sign(azOff) === Math.sign(azRate) && Math.abs(azOff) >= 0.5 && Math.abs(azOff) <= 10 : Math.abs(azOff) <= 3;
  const superOk = elOff >= IGLA.superElDeg[0] && elOff <= IGLA.superElDeg[1];
  const bore = dirOf(S.az, S.el), p0 = add(eye, bore, 1.0), id = E.missiles.length + 1;
  E.missiles.push({ id, cid: T.id, tick0: E.tick, p: p0, prev: [...p0] as Vec3, v: [bore[0] * IGLA.ejectMs, bore[1] * IGLA.ejectMs, bore[2] * IGLA.ejectMs], guided: true, state: 'fly', end: null, minD: 1e9 });
  E.launches.push({ tick: E.tick, cid: T.id, type: T.type, value: T.value, ident: iIdentOf(E, T.id), range: Math.round(Ls.range), alt: Math.round(T.p[2]),
    elOff: Math.round(elOff * 10) / 10, azOff: Math.round(azOff * 10) / 10, azRate: Math.round(azRate * 100) / 100, leadOk, superOk, envOk: iInEnvelope(E, T), missile: id });
  // The tube is expended; the BCU that powered the engagement is spent with it.
  L.tube = 'spent'; L.bcu = 'spent'; L.bcuOn = null; L.lockCid = null; L.lockStart = null; L.trigAt = null; L.seeker = 'off';
  E.reloads.push({ launch: E.tick, ready: null });
  E.ev.push({ tick: E.tick, k: 'launch', cid: T.id, n: id });
}

/** Fly a missile one tick in five sub-steps: ejection, boost, sustain and coast; proportional navigation on its target. */
function flyMissile(E: IglaEngine, m: IMissile): void {
  m.prev = [...m.p] as Vec3;
  const n = 5, h = E.dt / n, g = 9.81;
  for (let k = 0; k < n && m.state === 'fly'; k++) {
    const age = (E.tick - m.tick0) * E.dt + k * h, T = tgt(E, m.cid), live = !!T && T.state === 'live';
    const tp0 = live ? iTargetAt(T!, k / n) : null, tp1 = live ? iTargetAt(T!, (k + 1) / n) : null;
    let speed = len(m.v);
    const dir: Vec3 = [m.v[0] / speed, m.v[1] / speed, m.v[2] / speed];
    if (age >= IGLA.ejectSec && age < IGLA.ejectSec + 2) speed = Math.min(IGLA.vMax, speed + IGLA.boostAcc * h);
    else if (age >= IGLA.burnSec) speed = Math.max(60, speed - IGLA.coastDecel * h);
    let a: Vec3 = [0, 0, 0];
    if (m.guided && live && age >= IGLA.ejectSec) {
      const r = sub(tp1!, m.p), R = len(r), u: Vec3 = [r[0] / R, r[1] / R, r[2] / R];
      if (angBetween(dir, u) > IGLA.missileGimbalDeg) { m.guided = false; E.ev.push({ tick: E.tick, k: 'seekerLost', cid: m.cid ?? undefined, n: m.id }); }
      else {
        const vr = sub(T!.v, add([0, 0, 0], dir, speed)), Vc = -dot(vr, u), du = add(vr, u, -dot(vr, u)).map((x) => x / R) as Vec3;
        a = add([0, 0, g], du, IGLA.navN * Math.max(Vc, 50));
        a = add(a, dir, -dot(a, dir)); // lateral only
        const aMax = IGLA.aMaxG * g * Math.min(1, speed / IGLA.vMax), am = len(a);
        if (am > aMax) a = a.map((x) => (x * aMax) / am) as Vec3;
        speed = Math.max(60, speed - 0.04 * len(a) * h); // turning costs energy
      }
    }
    const v: Vec3 = [dir[0] * speed + a[0] * h, dir[1] * speed + a[1] * h, dir[2] * speed + (a[2] - g) * h];
    const p1 = add(m.p, v, h);
    if (live) {
      // Closest approach to the target over the sub-step (both move in straight lines).
      const d0 = sub(m.p, tp0!), d1 = sub(p1, tp1!), dd = sub(d1, d0), q = dot(dd, dd), s = q > 1e-9 ? clamp(-dot(d0, dd) / q, 0, 1) : 0, dmin = len(add(d0, dd, s));
      m.minD = Math.min(m.minD, dmin);
      if (dmin <= Math.max(0.8, iglaType(T!.type).spanM * 0.5)) {
        m.p = add(m.p, sub(p1, m.p), s); m.end = E.tick;
        if (age + s * h < IGLA.armSec) { m.state = 'miss'; m.why = 'unarmed'; E.ev.push({ tick: E.tick, k: 'missileMiss', cid: T!.id, n: m.id, text: 'unarmed' }); }
        else { m.state = 'hit'; end(E, T!, 'destroyed'); E.ev.push({ tick: E.tick, k: 'destroyed', cid: T!.id, n: m.id }); }
        break;
      }
    }
    m.v = v; m.p = p1;
    if (m.p[2] < 0) { m.state = 'miss'; m.why = 'ground'; m.end = E.tick; E.ev.push({ tick: E.tick, k: 'missileMiss', cid: m.cid ?? undefined, n: m.id, text: 'ground' }); }
    else if (age >= IGLA.flightSec) { m.state = 'miss'; m.why = 'selfDestruct'; m.end = E.tick; E.ev.push({ tick: E.tick, k: 'missileMiss', cid: m.cid ?? undefined, n: m.id, text: 'selfDestruct' }); }
  }
  if (m.state === 'fly' && segBlocked(E, m.prev, m.p) != null) { m.state = 'miss'; m.why = 'building'; m.end = E.tick; E.ev.push({ tick: E.tick, k: 'missileMiss', cid: m.cid ?? undefined, n: m.id, text: 'building' }); }
}

export function stepIgla(E: IglaEngine, acts: IglaAction[]): void {
  for (const a of acts) apply(E, a);
  const S = E.sol, L = E.lch, dt = E.dt, t = E.tick * dt;
  while (E.next < E.spawns.length && E.spawns[E.next].t <= t) spawn(E, E.spawns[E.next++]);
  // Reload steps finish.
  if (L.busy && E.tick >= L.busy.until) {
    if (L.busy.k === 'reload') { L.tube = 'live'; E.ev.push({ tick: E.tick, k: 'tubeOn' }); } else { L.bcu = 'fitted'; E.ev.push({ tick: E.tick, k: 'bcuFitted' }); }
    L.busy = null;
  }
  const lastR = E.reloads[E.reloads.length - 1];
  if (lastR && lastR.ready == null && L.tube === 'live' && L.bcu === 'fitted') { lastR.ready = E.tick; E.ev.push({ tick: E.tick, k: 'reloaded', n: Math.round((E.tick - lastR.launch) * dt) }); }
  // Walking (not while reloading); running needs the launcher down.
  S.running = S.run && S.f > 0 && !L.busy;
  const speed = L.busy ? 0 : S.raise > 0.5 ? IGLA.aimWalk : S.running ? IGLA.run : IGLA.walk, m = Math.hypot(S.f, S.s);
  if (m > 0 && speed > 0) {
    const fa = S.az * D2R, fx = Math.sin(fa), fy = Math.cos(fa), rx = Math.cos(fa), ry = -Math.sin(fa);
    const dx = ((fx * S.f + rx * S.s) / Math.max(1, m)) * speed * dt, dy = ((fy * S.f + ry * S.s) / Math.max(1, m)) * speed * dt;
    const x0 = S.x, y0 = S.y;
    if (!iBlocked(E, S.x + dx, S.y + dy)) { S.x += dx; S.y += dy; } else if (!iBlocked(E, S.x + dx, S.y)) S.x += dx; else if (!iBlocked(E, S.x, S.y + dy)) S.y += dy;
    S.odo += Math.hypot(S.x - x0, S.y - y0);
  }
  S.fatigue = clamp(S.fatigue + (S.running ? dt / 25 : -dt / 40), 0, 1);
  const canRaise = S.wantRaise && !L.busy && !S.running;
  S.raise = clamp(S.raise + (canRaise ? dt / IGLA.raiseSec : -dt / (IGLA.raiseSec * 0.7)), 0, 1);
  // Battery-coolant unit.
  if (L.bcu === 'active' && L.bcuOn != null) {
    const age = (E.tick - L.bcuOn) * dt;
    if (age >= IGLA.bcuSec) { L.bcu = 'spent'; L.bcuOn = null; E.bcuWasted++; L.lockCid = null; L.lockStart = null; L.trigAt = null; E.ev.push({ tick: E.tick, k: 'bcuOut' }); }
    else if (age >= IGLA.readySec && age - dt < IGLA.readySec) E.ev.push({ tick: E.tick, k: 'ready' });
  }
  // Seeker.
  const was = L.seeker;
  if (L.bcu !== 'active' || L.tube !== 'live' || L.bcuOn == null) { L.seeker = 'off'; L.lockCid = null; L.lockStart = null; }
  else if ((E.tick - L.bcuOn) * dt < IGLA.readySec) L.seeker = 'cooling';
  else if (S.raise < 1) { L.seeker = 'search'; if (L.lockCid != null && was === 'lock') E.ev.push({ tick: E.tick, k: 'lockLost', cid: L.lockCid }); L.lockCid = null; L.lockStart = null; L.trigAt = null; }
  else {
    if (L.lockCid != null) {
      const T = tgt(E, L.lockCid)!, locked = was === 'lock', lim = locked ? IGLA.gimbalDeg : IGLA.seekConeDeg;
      if (T.state !== 'live' || iOffBore(E, T.p) > lim || len(sub(T.p, iEye(E))) > iIrRangeM(E, T) * (locked ? 1.15 : 1) || !iClear(E, T.p)) {
        if (locked) E.ev.push({ tick: E.tick, k: 'lockLost', cid: L.lockCid });
        L.lockCid = null; L.lockStart = null; L.trigAt = null;
      }
    }
    if (L.lockCid == null) {
      let best: ITarget | null = null, bo = IGLA.seekConeDeg;
      for (const T of E.targets) {
        if (T.state !== 'live') continue;
        const o = iOffBore(E, T.p), r = len(sub(T.p, iEye(E)));
        if (o <= bo && r > 30 && r <= iIrRangeM(E, T) && iClear(E, T.p)) { best = T; bo = o; }
      }
      if (best) { L.lockCid = best.id; L.lockStart = E.tick; }
    }
    L.seeker = L.lockCid == null ? 'search' : E.tick - L.lockStart! >= sec(E, IGLA.lockSec) ? 'lock' : 'acq';
    if (L.seeker === 'lock' && was !== 'lock') E.ev.push({ tick: E.tick, k: 'lock', cid: L.lockCid! });
  }
  // Trigger → launch after the delay (the seeker must still hold the lock).
  if (L.trigAt != null && E.tick - L.trigAt >= sec(E, IGLA.launchDelaySec)) {
    if (L.seeker === 'lock' && L.lockCid != null) launch(E); else { L.trigAt = null; E.ev.push({ tick: E.tick, k: 'noLaunch', text: 'lost' }); }
  }
  // Drones, then missiles (which home on where the drones are this tick).
  for (const T of E.targets) if (T.state === 'live') moveTarget(E, T, t);
  for (const m of E.missiles) if (m.state === 'fly') flyMissile(E, m);
  // What can be seen.
  for (const T of E.targets) {
    if (T.state !== 'live') { E.vis[T.id] = 0; continue; }
    if (iVisible(E, T, true)) {
      E.seen[T.id] ??= E.tick; E.seenSec[T.id] = (E.seenSec[T.id] ?? 0) + dt;
      if (iInEnvelope(E, T) && len(sub(T.p, iEye(E))) <= iIrRangeM(E, T)) E.engSec[T.id] = (E.engSec[T.id] ?? 0) + dt;
    }
    E.vis[T.id] = iVisible(E, T) ? (E.vis[T.id] ?? 0) + 1 : 0;
  }
  E.tick++;
}

export const iglaMaxTicks = (E: IglaEngine): number => sec(E, E.cfg.maxSec ?? 300);
/** Over when the time is up, the gunner is struck, or every contact is resolved and no missile is in the air. */
export function iglaDone(E: IglaEngine): boolean {
  if (E.tick >= iglaMaxTicks(E) || E.sol.struck) return true;
  if (E.next < E.spawns.length || E.targets.some((t) => t.state === 'live' && t.type !== 'bird') || E.missiles.some((m) => m.state === 'fly')) return false;
  return E.tick >= Math.max(0, ...E.targets.map((t) => t.endTick ?? 0), ...E.missiles.map((m) => m.end ?? 0)) + sec(E, 3);
}
export function runIgla(cfg: IglaCfg, W: PatrolWorld, o: { actions?: IglaAction[]; policy?: (E: IglaEngine) => IglaAction[]; stopWhenDone?: boolean } = {}, C: Config = getConfig()): IglaEngine {
  const E = createIgla(cfg, W, C), by = new Map<number, IglaAction[]>();
  for (const a of o.actions ?? []) (by.get(a.tick) ?? by.set(a.tick, []).get(a.tick)!).push(a);
  while (E.tick < iglaMaxTicks(E)) {
    stepIgla(E, (by.get(E.tick) ?? []).concat((o.policy?.(E) ?? []).map((a) => ({ ...a, tick: E.tick }))));
    if ((o.stopWhenDone ?? true) && iglaDone(E)) break;
  }
  return E;
}

// ---------- the expert gunner (tests and the demo) ----------
/** Is this spot shielded by a building from a drone at `from`, and all along its dive (from 70 m out and 45 m up)? */
function shielded(E: IglaEngine, from: Vec3, x: number, y: number): boolean {
  const eye: Vec3 = [x, y, IGLA.eyeM], th = Math.hypot(from[0] - x, from[1] - y) || 1, ux = (from[0] - x) / th, uy = (from[1] - y) / th;
  if (segBlocked(E, from, eye) == null) return false;
  for (const [d, z] of [[70, 45], [45, 30], [25, 17], [12, 8]]) if (segBlocked(E, [x + ux * d, y + uy * d, z], eye) == null) return false;
  return true;
}
/** The nearest spot on foot (within 60 m, around walls and fences) that a building shields from a drone at `from`:
 *  the path there as waypoints, or null. */
export const iCoverFrom = (E: IglaEngine, from: Vec3): [number, number][] | null => iPathTo(E, (x, y) => shielded(E, from, x, y));
/** The nearest spot on foot (within 60 m, around walls and fences) where `ok` holds: the path there as waypoints, or
 *  null. Breadth-first search over a 1 m grid. */
export function iPathTo(E: IglaEngine, ok: (x: number, y: number) => boolean): [number, number][] | null {
  const S = E.sol, R = 60, N = 2 * R + 1, seen = new Int32Array(N * N).fill(-1), q: number[] = [], x0 = S.x - R, y0 = S.y - R;
  const start = R * N + R; seen[start] = start; q.push(start);
  for (let h = 0; h < q.length; h++) {
    const c = q[h], ci = c % N, cj = (c - ci) / N, x = x0 + ci, y = y0 + cj;
    if (h > 0 && ok(x, y)) {
      const path: [number, number][] = [];
      for (let k = c; k !== start; k = seen[k]) path.push([x0 + (k % N), y0 + Math.floor(k / N)]);
      return path.reverse();
    }
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ni = ci + di, nj = cj + dj, n = nj * N + ni;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N || seen[n] >= 0) continue;
      if ((ni - R) ** 2 + (nj - R) ** 2 > R * R || iBlocked(E, x0 + ni, y0 + nj)) { seen[n] = -2; continue; }
      // No cutting corners (a diagonal step needs both side cells free) and no stepping through a thin wall.
      if (di && dj && (iBlocked(E, x0 + ci + di, y0 + cj) || iBlocked(E, x0 + ci, y0 + cj + dj))) continue;
      if ([0.25, 0.5, 0.75].some((f) => iBlocked(E, x + di * f, y + dj * f))) continue;
      seen[n] = c; q.push(n);
    }
  }
  return null;
}
interface PlanC { tick: number; cid: number; path: [number, number][] | null; x: number; y: number }
const coverCache = new WeakMap<IglaEngine, PlanC>(), moveCache = new WeakMap<IglaEngine, PlanC>();
/** Walking but not getting anywhere (a post or a corner): plan again from here. */
const stuck = (E: IglaEngine, c: PlanC | undefined) => { const r = !!c && E.sol.f > 0 && Math.hypot(E.sol.x - c.x, E.sol.y - c.y) < 0.02; if (c) { c.x = E.sol.x; c.y = E.sol.y; } return r; };
export function iglaAI(E: IglaEngine): IglaAction[] {
  const out: IglaAction[] = [], S = E.sol, L = E.lch, k = (a: Omit<IglaAction, 'tick'>) => out.push({ ...a, tick: E.tick }), eye = iEye(E);
  const look = (az: number, el: number) => { if (Math.abs(angDiff(az, S.az)) > 0.05 || Math.abs(el - S.el) > 0.05) k({ k: 'look', az: Math.round(az * 100) / 100, el: Math.round(el * 100) / 100 }); };
  const move = (f: number, run: boolean) => { if (f !== S.f || S.s !== 0 || run !== S.run) k({ k: 'move', f, s: 0, run }); };
  const raise = (on: boolean) => { if (on !== S.wantRaise) k({ k: 'raise', on }); };
  const follow = (path: [number, number][] | null) => {
    while (path && path.length > 1 && Math.hypot(path[0][0] - S.x, path[0][1] - S.y) < 0.8) path.shift();
    const w = path?.[0];
    if (w) { const d = Math.hypot(w[0] - S.x, w[1] - S.y); look((Math.atan2(w[0] - S.x, w[1] - S.y) / D2R + 360) % 360, 5); move(d > 0.2 ? 1 : 0, (path?.length ?? 0) > 3); } else move(0, false);
  };
  // 1. An FPV hunting the gunner: run behind a building (it needs to see him to hit him).
  const hunter = E.targets.filter((T) => T.state === 'live' && T.goal === 'hunt' && Math.hypot(T.p[0] - S.x, T.p[1] - S.y) < 700).sort((a, b) => Math.hypot(a.p[0] - S.x, a.p[1] - S.y) - Math.hypot(b.p[0] - S.x, b.p[1] - S.y))[0];
  if (hunter && !(iIdentOf(E, hunter.id) == null && iVisible(E, hunter, true) && Math.hypot(hunter.p[0] - S.x, hunter.p[1] - S.y) > 450)) {
    raise(false);
    // Already shielded: stay put. Otherwise follow the path to the nearest shielded spot (re-planned every second).
    if (shielded(E, hunter.p, S.x, S.y)) { move(0, false); return out; }
    // Keep the chosen spot while it still shields from the drone (re-planning every tick makes the gunner dither).
    let cc = coverCache.get(E);
    const goal = cc?.path?.[cc.path.length - 1];
    if (stuck(E, cc) || !cc || cc.cid !== hunter.id || !goal || (E.tick - cc.tick >= sec(E, 1) && !shielded(E, hunter.p, goal[0], goal[1]))) { cc = { tick: E.tick, cid: hunter.id, path: iCoverFrom(E, hunter.p), x: S.x, y: S.y }; coverCache.set(E, cc); }
    follow(cc.path);
    return out;
  }
  if (L.busy) { if (S.f || S.s || S.run) move(0, false); return out; }
  // 2. Reload after a launch: gripstock to a fresh tube, then a fresh BCU.
  if (L.tube === 'spent' && L.tubes > 0) { k({ k: 'reload' }); return out; }
  if (L.tube === 'live' && (L.bcu === 'spent' || L.bcu === 'none') && L.bcus > 0) { k({ k: 'bcu' }); return out; }
  // 3. Identify what can be seen through the sight (after a second and a half on it).
  const flying = new Set(E.missiles.filter((m) => m.state === 'fly').map((m) => m.cid));
  const unid = E.targets.filter((T) => T.state === 'live' && iIdentOf(E, T.id) == null && iVisible(E, T, true)).sort((a, b) => len(sub(a.p, eye)) - len(sub(b.p, eye)))[0];
  // 4. Engage the nearest identified target worth a missile, inside the envelope and the seeker's range.
  const cand = E.targets.filter((T) => T.state === 'live' && T.value === 'high' && iIdentOf(E, T.id) === T.type && !flying.has(T.id) && iVisible(E, T, true) && iInEnvelope(E, T) && len(sub(T.p, eye)) < iIrRangeM(E, T) * 0.95)
    .sort((a, b) => len(sub(a.p, eye)) - len(sub(b.p, eye)));
  const T = L.lockCid != null && cand.some((c) => c.id === L.lockCid) ? tgt(E, L.lockCid)! : cand[0];
  if (unid && (L.seeker !== 'lock' || L.lockCid === unid.id)) {
    raise(true); const Ls = losOf(sub(add(unid.p, unid.v, E.dt), eye)); look(Ls.az, Ls.el);
    if (S.raise >= 1 && (E.vis[unid.id] ?? 0) >= sec(E, 1.5)) k({ k: 'ident', cid: unid.id, cls: unid.type });
    return out;
  }
  if (T && L.tube === 'live' && L.bcu !== 'spent' && L.bcu !== 'none') {
    // The seeker took another drone in its field of view: lower the launcher to drop that lock, then aim again.
    if (L.lockCid != null && L.lockCid !== T.id) { raise(false); return out; }
    // A wall or fence in front of the tube: move to a spot with a clear line to the target first.
    const lineOk = (x: number, y: number) => segBlocked(E, [x, y, IGLA.eyeM], add([x, y, IGLA.eyeM], dirOf(losOf(sub(T.p, [x, y, IGLA.eyeM])).az, losOf(sub(T.p, [x, y, IGLA.eyeM])).el + 6), 60)) == null && segBlocked(E, [x, y, IGLA.eyeM], T.p, false) == null;
    if (!lineOk(S.x, S.y)) {
      let mc = moveCache.get(E);
      if (stuck(E, mc) || !mc || mc.cid !== T.id || E.tick - mc.tick >= sec(E, 3)) { mc = { tick: E.tick, cid: T.id, path: iPathTo(E, lineOk), x: S.x, y: S.y }; moveCache.set(E, mc); }
      if (mc.path?.length) { raise(false); follow(mc.path); return out; }
    }
    if (S.f || S.s) move(0, false);
    raise(true);
    if (L.bcu === 'fitted') k({ k: 'power' });
    const Ls = losOf(sub(add(T.p, T.v, E.dt), eye));
    if (L.seeker === 'lock' && L.lockCid === T.id) {
      const L1 = losOf(sub(add(T.p, T.v, 1), eye)), rate = angDiff(L1.az, Ls.az);
      const az = Ls.az + (Math.abs(rate) > 0.4 ? Math.sign(rate) * clamp(Math.abs(rate) * 2, 1, 6) : 0), el = Ls.el + 6;
      look(az, el);
      if (L.trigAt == null && Math.abs(angDiff(az, S.az)) < 0.6 && Math.abs(el - S.el) < 0.6 && iLaunchClear(E)) k({ k: 'trig', on: true });
    } else look(Ls.az, Ls.el);
    return out;
  }
  if (S.f || S.s || S.run) move(0, false);
  raise(false);
  return out;
}

// ---------- scoring (rules I1–I9) ----------
export const IGLA_RULES: Record<string, string> = {
  I1: 'Identify every contact you could see through the sight (15): right type full, right side half, Unknown a third.',
  I2: 'Missile discipline (20): a missile only at an identified target worth one; −10 for a missile at an FPV or small quad, −5 for one at a contact not yet identified.',
  I3: 'Kill the targets worth a missile that you could engage (25): in sight, inside the envelope and the seeker range for 5 s or more; out of as many as you have tubes.',
  I4: 'Launch inside the envelope (10): 500 m to 5.2 km, up to 3.5 km high.',
  I5: 'Lead and super-elevation at launch (10): the launcher 2–10° above the target and ahead of a crossing target.',
  I6: 'Battery-coolant units (5): switch on only when there is a target to lock (−2.5 for each one run out unused).',
  I7: 'Reload drill (5): gripstock to a fresh tube and a fresh BCU within 25 s of the launch.',
  I8: 'Survive (10): take cover from FPV drones; struck = drill over.',
  I9: 'Never fire on a friendly aircraft, a civil drone or a bird (−30 each).',
};
export interface IglaScore {
  game: 'igla'; total: number; parts: GunPart[]; deductions: GunPart[]; why: string[]; rules: string[];
  metrics: { launches: number; hits: number; kills: number; worth: number; engageable: number; wrongLaunches: number; bcuWasted: number; reloadSec: number | null; struck: boolean; identified: string; distanceM: number };
}
export function scoreIgla(E: IglaEngine): IglaScore {
  const T = E.C.threats.threats, why: string[] = [], rules = new Set<string>(), name = (t: ITarget) => `Contact ${t.id} (${T[t.type]?.short ?? t.type})`;
  const part = (rule: string, label: string, max: number, frac: number): GunPart => ({ rule, label, max, pts: Math.round(max * clamp(frac, 0, 1) * 10) / 10, why: [] });
  // I1
  const seen = E.targets.filter((t) => (E.seenSec[t.id] ?? 0) >= 6);
  let idp = 0;
  for (const t of seen) {
    const c = iIdentOf(E, t.id), p = c == null ? 0 : c === 'unknown' ? 1 / 3 : c === t.type ? 1 : !!T[c]?.hostile === t.hostile ? 0.5 : 0;
    idp += p; if (p < 1) { why.push(`I1 ${name(t)}: ${c == null ? 'in sight but not identified' : c === 'unknown' ? 'left as Unknown' : `identified as ${T[c]?.short ?? c}`}.`); rules.add('I1'); }
  }
  // I2 / I9
  let disc = 20, frat = 0;
  for (const l of E.launches) {
    const t = tgt(E, l.cid)!;
    if (l.value === 'never') { frat++; why.push(`I9 Missile at ${name(t)}: never engage a ${t.type === 'bird' ? 'bird' : T[t.type]?.friendly ? 'friendly aircraft' : 'civil drone'}.`); rules.add('I9'); continue; }
    if (l.value === 'low') { disc -= 10; why.push(`I2 Missile at ${name(t)}: not worth an Igla. Take cover and report it for the guns and jammers.`); rules.add('I2'); }
    else if (l.ident == null || l.ident === 'unknown') { disc -= 5; why.push(`I2 Missile at ${name(t)} before identifying it.`); rules.add('I2'); }
  }
  // I3: targets worth a missile that were in sight inside the envelope.
  // A target with a missile still on its way when the time ran out is undecided: left out.
  const inAir = new Set(E.missiles.filter((m) => m.state === 'fly').map((m) => m.cid));
  const worth = E.targets.filter((t) => t.value === 'high'), engageable = worth.filter((t) => ((E.engSec[t.id] ?? 0) >= 5 && !(t.state === 'live' && inAir.has(t.id))) || t.state === 'destroyed');
  const kills = worth.filter((t) => t.state === 'destroyed').length, killedEng = engageable.filter((t) => t.state === 'destroyed').length;
  for (const t of engageable) if (t.state !== 'destroyed') { why.push(`I3 ${name(t)}: worth a missile and engageable for ${Math.round(E.engSec[t.id] ?? 0)} s, not destroyed${t.leakKind === 'observed' ? ' (it fixed your position)' : t.leakKind === 'asset' ? ' (it struck the town)' : ''}.`); rules.add('I3'); }
  // I4 / I5
  const fair = E.launches.filter((l) => l.value !== 'never');
  const env = fair.filter((l) => l.envOk).length, lead = fair.filter((l) => l.leadOk && l.superOk).length;
  for (const l of fair) {
    if (!l.envOk) { why.push(`I4 Launch at ${l.range} m, height ${l.alt} m: outside the envelope.`); rules.add('I4'); }
    if (!l.superOk || !l.leadOk) { why.push(`I5 Launch on contact ${l.cid}: launcher ${l.elOff >= 0 ? '+' : ''}${l.elOff}° above and ${Math.abs(l.azOff)}° ${l.azOff * l.azRate > 0 ? 'ahead of' : 'behind'} the target${!l.superOk ? '; lift 2–10° above it' : ''}${!l.leadOk ? '; lead a crossing target' : ''}.`); rules.add('I5'); }
  }
  // I6 / I7 / I8
  if (E.bcuWasted) { why.push(`I6 ${E.bcuWasted} battery-coolant unit${E.bcuWasted === 1 ? '' : 's'} ran out before a launch: switch on when the target is close enough to lock.`); rules.add('I6'); }
  const rs = E.reloads.filter((r) => r.ready != null || (E.tick - r.launch) * E.dt >= IGLA.reloadStdSec).map((r) => (r.ready == null ? null : (r.ready - r.launch) * E.dt));
  const rFrac = rs.length ? rs.reduce<number>((a, s) => a + (s == null ? (E.lch.tubes > 0 && E.lch.bcus > 0 ? 0 : 1) : clamp((60 - s) / (60 - IGLA.reloadStdSec), 0, 1)), 0) / rs.length : 1;
  if (rFrac < 1) { why.push(`I7 Reload: ${rs.map((s) => (s == null ? 'not finished' : `${Math.round(s)} s`)).join(', ')} (standard ${IGLA.reloadStdSec} s).`); rules.add('I7'); }
  if (E.sol.struck) { why.push('I8 Struck by an FPV drone in the open: break the line of sight behind a building.'); rules.add('I8'); }
  const parts: GunPart[] = [
    part('I1', 'Identify', 15, seen.length ? idp / seen.length : 1),
    part('I2', 'Missile discipline', 20, disc / 20),
    part('I3', 'Kills worth a missile', 25, engageable.length ? killedEng / Math.min(engageable.length, E.cfg.tubes ?? IGLA.tubes) : 1),
    part('I4', 'Envelope', 10, fair.length ? env / fair.length : 1),
    part('I5', 'Lead and super-elevation', 10, fair.length ? lead / fair.length : 1),
    part('I6', 'Battery-coolant units', 5, 1 - E.bcuWasted * 0.5),
    part('I7', 'Reload drill', 5, rFrac),
    part('I8', 'Survive', 10, E.sol.struck ? 0 : 1),
  ];
  const ded: GunPart[] = frat ? [{ rule: 'I9', label: 'Friendly, civil or bird engaged', pts: -30 * frat, max: 0, why: [] }] : [];
  const total = clamp(Math.round(parts.reduce((s, p) => s + p.pts, 0) + ded.reduce((s, d) => s + d.pts, 0)), 0, 100);
  const done = rs.filter((s): s is number => s != null);
  return { game: 'igla', total, parts, deductions: ded, why, rules: [...rules],
    metrics: { launches: E.launches.length, hits: E.missiles.filter((m) => m.state === 'hit').length, kills, worth: worth.length, engageable: engageable.length,
      wrongLaunches: E.launches.filter((l) => l.value !== 'high').length, bcuWasted: E.bcuWasted, reloadSec: done.length ? Math.round(done.reduce((a, b) => a + b, 0) / done.length) : null,
      struck: E.sol.struck, identified: `${seen.filter((t) => iIdentOf(E, t.id) === t.type).length}/${seen.length}`, distanceM: Math.round(E.sol.odo) } };
}
