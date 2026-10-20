import { closestApproach, angDiff, dirOf, fly, gauss, losOf, muzzleVelocity, solveAim, type AimSolution, type Met, type Vec3 } from './ballistics';
import { getConfig, gunsOf, type Config, type Gun, type GunsFile } from './config';
import type { Terrain, TimeOfDay, Weather } from './types';
import { clamp, hash2, mulberry } from './util';

/**
 * Gun detachment drill (ZU-23-2 manual sight / ZSU-23-4 radar fire control), shared by both games:
 *  - On Ground: the trainee is the gun; orders come from the control room (AI, or a person over LAN).
 *  - Control Room: the trainee gives the orders; the gun is crewed by the AI (or people over LAN).
 * Every input from either seat is a time-stamped action, so a drill is fully defined by its config and its log
 * and the unit server can re-run it. All randomness comes from the seed (hash2 / mulberry).
 */
export type Seat = 'cr' | 'gun';
/** Fire orders in the fixed sequence Alert → Indicate (target) → Method → Executive (engage). Cease fire = stop firing,
 *  keep tracking; Hold fire = emergency stop on everything (US/NATO usage; Indian wording to be confirmed). */
export type OrderKind = 'rangeClear' | 'alert' | 'target' | 'method' | 'engage' | 'cease' | 'hold' | 'unload' | 'rangeGreen';
/** Weapon Control Status (NATO terms): hold = fire only in self-defence or on direct order; tight = only positively identified hostiles; free = anything not identified friendly. */
export type Wcs = 'hold' | 'tight' | 'free';
/** Air Defence Warning (NATO terms): sets how long the crew needs to be at the gun. */
export type Adw = 'white' | 'yellow' | 'red';
export type KillOutcome = 'destroyed' | 'noEffect';
export type GunActionKind = 'order' | 'check' | 'uxo' | 'rstep' | 'ack' | 'post' | 'kill' | 'load' | 'safety' | 'lay' | 'slew' | 'trig' | 'sight' | 'lock' | 'clear' | 'barrel' | 'unload' | 'report';
export interface GunAction {
  tick: number; seat: Seat; k: GunActionKind;
  /** order */ o?: OrderKind; cid?: number;
  /** safety on / trigger down */ on?: boolean;
  /** slew rates, −1…1 of the gun's maximum */ az?: number; el?: number;
  /** manual sight settings: target speed (m/s), course angle (deg, + = moving right), range (m) */ spd?: number; crs?: number; rng?: number;
  /** report: rounds expended */ n?: number;
  /** kill assessment */ out?: KillOutcome;
  /** live-fire check item id; unexploded round index found */ item?: string; i?: number;
}
export interface GunSpawn { type: string; t: number; brg: number; dist: number; alt: number; passM: number; }
export interface GunDrillConfig {
  seed: number; gun: string; time: TimeOfDay; terrain: Terrain; weather?: Weather; difficulty: number;
  met: Met; issueRounds: number; stoppages: boolean; radarFault?: boolean; maxSec?: number;
  /** Control measures. Missing = tight / red (crew at the gun) / no safe arcs. */
  wcs?: Wcs; adw?: Adw;
  /** Safe arcs: [from, to] bearings in degrees (clockwise) the gun must never fire into. */
  safeArcs?: [number, number][];
  /** Practice drill with no targets: 'reload' = timed reloads only. */
  practice?: 'reload';
}
export type TargetState = 'pending' | 'live' | 'destroyed' | 'leaked' | 'gone';
export interface GunTarget {
  id: number; type: string; hostile: boolean; spawnTick: number; p0: Vec3; v: Vec3; weave: number; hoverAtSec: number | null;
  /** Fixed-wing surveillance: after hoverAtSec, circle the gun at this radius (m). */ orbitR: number | null;
  state: TargetState; hits: number; endTick: number | null; designatedTick: number | null;
}
export interface Round { i: number; tick: number; t0: number; az: number; el: number; mv: number; cid: number | null; miss: number; tau: number; hit: boolean; authorised: boolean; dud: boolean; }
export interface Burst { start: number; end: number | null; rounds: number; cid: number | null; authorised: boolean; maxRangeM: number; bestMiss: number; hits: number; safeArc: boolean; afterHold: boolean;
  /** Sight settings and radar lock when the burst began (for the ballistic-solution score). */ sight: { spd: number; crs: number; rng: number } | null; locked: boolean; }
export interface GunEvent { tick: number; k: string; cid?: number; n?: number; o?: OrderKind; out?: KillOutcome; text?: string; }
export interface OrderRec { tick: number; o: OrderKind; cid: number | null; ackTick: number | null; }
export interface GunState {
  posted: boolean; az: number; el: number; rAz: number; rEl: number; layCid: number | null; laidTick: number | null;
  loaded: boolean; safety: boolean; trig: boolean; ready: number; reserve: number; busy: 'post' | 'load' | 'rstep' | 'clear' | 'barrel' | 'unload' | null;
  /** Reload drill: index of the next step. */ rIdx: number; busyUntil: number;
  stoppage: boolean; heat: number; overheatRounds: number; sight: { spd: number; crs: number; rng: number } | null; sightTick: number | null;
  lockCid: number | null; lockStart: number | null; acc: number; fired: number; unloaded: boolean; reported: number | null; reportTick: number | null;
}
export interface GunEngine {
  C: Config; G: GunsFile; gun: Gun; cfg: GunDrillConfig; tick: number; dt: number;
  spawns: GunSpawn[]; next: number; targets: GunTarget[]; g: GunState;
  /** Tick a friendly/civil aircraft came within 5° of the line of fire while firing was cleared (null when clear). */
  nhIn: number | null;
  /** Live-fire procedure: check item → tick done; unexploded rounds located; RANGE GREEN tick. */
  checks: Record<string, number>; uxoFound: number[]; rangeGreenTick: number | null;
  /** Every reload: start and end ticks, and steps done out of order. */
  reloads: { start: number; end: number | null; errors: number; steps: boolean }[];
  orders: OrderRec[]; rangeClear: boolean; cleared: number | null; ceased: boolean; held: boolean; unloadOrdered: boolean; kills: { tick: number; cid: number; out: KillOutcome }[];
  rounds: Round[]; bursts: Burst[]; pending: { tick: number; cid: number }[]; ev: GunEvent[]; fcs: AimSolution | null;
}

const MIL = 180 / Math.PI / 1000; // 1 mil (milliradian) in degrees
const HORIZON_M = 4500;

/** Target position at absolute time t (s). Straight flight, optional weave, optional hover at a stand-off point. */
export function targetPos(T: GunTarget, t: number, dt: number): Vec3 {
  let s = Math.max(0, t - T.spawnTick * dt);
  if (T.hoverAtSec != null && s > T.hoverAtSec && T.orbitR) {
    const e: Vec3 = [T.p0[0] + T.v[0] * T.hoverAtSec, T.p0[1] + T.v[1] * T.hoverAtSec, T.p0[2]];
    const th = Math.atan2(e[0], e[1]) + (Math.hypot(T.v[0], T.v[1]) / T.orbitR) * (s - T.hoverAtSec);
    return [Math.sin(th) * T.orbitR, Math.cos(th) * T.orbitR, T.p0[2]];
  }
  if (T.hoverAtSec != null) s = Math.min(s, T.hoverAtSec);
  const p: Vec3 = [T.p0[0] + T.v[0] * s, T.p0[1] + T.v[1] * s, T.p0[2] + T.v[2] * s];
  if (T.weave) { const sp = Math.hypot(T.v[0], T.v[1]) || 1, w = T.weave * Math.sin(s * 0.9); p[0] += (-T.v[1] / sp) * w; p[1] += (T.v[0] / sp) * w; }
  return p;
}
/** Observed velocity: averaged over the last `win` seconds, as a gunner's eye or a radar tracker smooths a weaving track. */
export const targetVel = (T: GunTarget, t: number, dt: number, win = 2): Vec3 => {
  const w = Math.max(0.1, Math.min(win, t - T.spawnTick * dt)), a = targetPos(T, t - w, dt), b = targetPos(T, t, dt);
  return [(b[0] - a[0]) / w, (b[1] - a[1]) / w, (b[2] - a[2]) / w];
};

/** Procedural gun drill: targets from the threat library, difficulty sets numbers, speeds and crossing distances. */
export function buildGunScenario(cfg: GunDrillConfig, C: Config = getConfig()): GunSpawn[] {
  if (cfg.practice) return [];
  const r = mulberry(cfg.seed * 7 + 1301), T = C.threats.threats;
  const pool = ['fpv', 'recon', 'aiStrike', 'dropper', 'loiter', 'fibre'].filter((k) => T[k]);
  const n = clamp(1 + Math.floor(cfg.difficulty / 2), 1, 4), out: GunSpawn[] = [];
  for (let i = 0; i < n; i++) {
    const type = pool[Math.floor(r() * pool.length)], ty = T[type];
    // Attackers fly at the asset (small offset); surveillance types stand off. Start far enough for about 35–55 s of flight.
    const attack = ty.motion !== 'approachHover' && ty.motion !== 'surveil';
    out.push({ type, t: 4 + i * (14 - cfg.difficulty) + r() * 4, brg: Math.round(r() * 359), dist: clamp(ty.speed * (35 + r() * 20) + 600, 1400, 3800),
      alt: clamp(ty.alt[0] + r() * (ty.alt[1] - ty.alt[0]), 30, 900), passM: attack ? Math.round((r() - 0.5) * 80) : Math.round((r() - 0.5) * 600) });
  }
  // A friendly or civil aircraft from difficulty 3: the order will be HOLD FIRE.
  if (cfg.difficulty >= 3) {
    const k = r() < 0.5 ? 'friendly' : 'civil';
    if (T[k]) out.push({ type: k, t: 10 + r() * 20, brg: Math.round(r() * 359), dist: 3200, alt: 200, passM: 600 + Math.round(r() * 400) });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function defaultGunCfg(o: Partial<GunDrillConfig> = {}): GunDrillConfig {
  const gun = o.gun ?? 'zu23';
  return { seed: 1, gun, time: 'day', terrain: 'rural', difficulty: 3, met: { tempC: 30, pressureHpa: 1005, wind: [0, 0, 0], latitudeDeg: 26 }, issueRounds: gun === 'zsu234' ? 1000 : 400, stoppages: true, ...o };
}

export function createGun(cfg: GunDrillConfig, C: Config = getConfig(), spawns?: GunSpawn[]): GunEngine {
  const G = gunsOf(C), gun = G.guns[cfg.gun];
  if (!gun) throw new Error(`Unknown gun "${cfg.gun}"`);
  return {
    C, G, gun, cfg, tick: 0, dt: C.training.sim.dt, spawns: spawns ?? buildGunScenario(cfg, C), next: 0, targets: [],
    g: { rIdx: 0, posted: (cfg.adw ?? 'red') === 'red', az: 0, el: 5, rAz: 0, rEl: 0, layCid: null, laidTick: null, loaded: false, safety: true, trig: false, ready: 0, reserve: cfg.issueRounds,
      busy: null, busyUntil: 0, stoppage: false, heat: 0, overheatRounds: 0, sight: null, sightTick: null, lockCid: null, lockStart: null, acc: 0, fired: 0,
      unloaded: false, reported: null, reportTick: null },
    nhIn: null, checks: {}, uxoFound: [], rangeGreenTick: null, reloads: [], orders: [], rangeClear: false, cleared: null, ceased: false, held: false, unloadOrdered: false, kills: [], rounds: [], bursts: [], pending: [], ev: [], fcs: null,
  };
}

const sec = (E: GunEngine, s: number) => Math.round(s / E.dt);
const live = (E: GunEngine) => E.targets.filter((t) => t.state === 'live');
const tgt = (E: GunEngine, id: number | null | undefined) => (id == null ? undefined : E.targets.find((t) => t.id === id));
const barrelDir = (E: GunEngine) => dirOf(E.g.az, E.g.el);
/** The live target nearest the barrel's line (deg), if any within `maxDeg`. */
export function targetOnLine(E: GunEngine, maxDeg = 8): GunTarget | undefined {
  let best: GunTarget | undefined, bd = maxDeg;
  for (const T of live(E)) {
    const L = losOf(targetPos(T, E.tick * E.dt, E.dt));
    const d = Math.hypot(angDiff(L.az, E.g.az) * Math.cos((L.el * Math.PI) / 180), L.el - E.g.el);
    if (d < bd) { bd = d; best = T; }
  }
  return best;
}
/** Is firing authorised right now on this target: range clear, an ENGAGE order on it, no hold/check/cease since. */
export const authorised = (E: GunEngine, cid: number | null): boolean => E.rangeClear && !E.held && E.cleared != null && cid === E.cleared;
/** Is this bearing inside one of the drill's safe arcs? */
export function inSafeArc(cfg: GunDrillConfig, az: number): boolean {
  return (cfg.safeArcs ?? []).some(([a, b]) => { const x = ((az % 360) + 360) % 360; return a <= b ? x >= a && x <= b : x >= a || x <= b; });
}

/** What the gun's sight assumes about the target: manual sight settings, or the radar track (with noise). */
export function sightSolution(E: GunEngine, warm?: AimSolution | null): AimSolution | null {
  const am = E.G.ammo[E.gun.ammo], mv = muzzleVelocity(am, E.cfg.met.tempC, E.G.met.stdTempC);
  const t = E.tick * E.dt;
  if (E.gun.sight === 'radar' && !E.cfg.radarFault && E.g.lockCid != null && E.g.lockStart != null && E.tick - E.g.lockStart >= sec(E, E.gun.radar?.lockSec ?? 0)) {
    const T = tgt(E, E.g.lockCid);
    if (!T || T.state !== 'live') return null;
    const n = (E.gun.radar?.trackNoiseMil ?? 0) * MIL * Math.PI / 180, p = targetPos(T, t, E.dt), R = Math.hypot(...p);
    const np: Vec3 = [p[0] + gauss(E.cfg.seed + 11, E.tick) * n * R, p[1] + gauss(E.cfg.seed + 12, E.tick) * n * R, p[2] + gauss(E.cfg.seed + 13, E.tick) * n * R];
    return solveAim(am, mv, E.cfg.met, np, targetVel(T, t, E.dt), warm);
  }
  const s = E.g.sight;
  if (!s) return null;
  // Manual (ZAP-23 style) sight: the layer holds the target in the sight; the sight assumes the set speed, course and range.
  const T = targetOnLine(E, E.gun.sightFovDeg / 2);
  if (!T) return null;
  const L = losOf(targetPos(T, t, E.dt)), p = dirOf(L.az, L.el).map((x) => x * s.rng) as Vec3;
  const hdg = ((L.az + 180 - s.crs) * Math.PI) / 180; // course angle: 0 = coming straight at the gun, + = crossing to the right
  return solveAim(am, mv, E.cfg.met, p, [Math.sin(hdg) * s.spd, Math.cos(hdg) * s.spd, 0], warm);
}

function order(E: GunEngine, a: GunAction): void {
  const o = a.o!; const rec: OrderRec = { tick: E.tick, o, cid: a.cid ?? null, ackTick: null };
  E.orders.push(rec); E.ev.push({ tick: E.tick, k: 'order', o, cid: a.cid });
  if (o === 'rangeClear') E.rangeClear = true;
  else if (o === 'target') { const T = tgt(E, a.cid); if (T && T.designatedTick == null) T.designatedTick = E.tick; }
  else if (o === 'alert') { if (!E.g.posted && E.g.busy !== 'post') E.ev.push({ tick: E.tick, k: 'alerted' }); }
  else if (o === 'engage') { E.cleared = a.cid ?? null; E.ceased = false; E.held = false; }
  else if (o === 'hold') { E.cleared = null; E.held = true; }
  else if (o === 'cease') { E.cleared = null; E.ceased = true; }
  else if (o === 'unload') E.unloadOrdered = true;
  else if (o === 'rangeGreen' && E.rangeGreenTick == null) E.rangeGreenTick = E.tick;
}

function apply(E: GunEngine, a: GunAction): void {
  const g = E.g, P = E.G.procedure;
  if (a.k === 'order' && a.seat === 'cr' && a.o) return order(E, a);
  const lfx = E.G.lfx;
  if (a.k === 'check' && lfx && a.item && E.checks[a.item] == null && (a.seat === 'gun' ? lfx.gunChecks : lfx.rangeChecks).some((c) => c.id === a.item)) { E.checks[a.item] = E.tick; E.ev.push({ tick: E.tick, k: 'check', text: a.item }); return; }
  if (a.k === 'uxo' && a.seat === 'cr' && a.i != null && unexploded(E).some((r) => r.i === a.i) && !E.uxoFound.includes(a.i)) { E.uxoFound.push(a.i); E.ev.push({ tick: E.tick, k: 'uxoFound', n: a.i }); return; }
  if (a.seat !== 'gun') return;
  switch (a.k) {
    case 'ack': { const r = [...E.orders].reverse().find((x) => x.ackTick == null); if (r) { r.ackTick = E.tick; E.ev.push({ tick: E.tick, k: 'ack', o: r.o }); } return; }
    case 'post': if (!g.posted && !g.busy) { g.busy = 'post'; g.busyUntil = E.tick + sec(E, P.standToSec?.[E.cfg.adw ?? 'red'] ?? 0); } return;
    case 'kill': if (a.cid != null && a.out) { E.kills.push({ tick: E.tick, cid: a.cid, out: a.out }); E.ev.push({ tick: E.tick, k: 'killReport', cid: a.cid, out: a.out }); } return;
    case 'load': if (g.posted && !g.busy && !g.loaded && g.reserve > 0 && g.rIdx === 0) { g.busy = 'load'; g.busyUntil = E.tick + sec(E, P.loadSec); E.reloads.push({ start: E.tick, end: null, errors: 0, steps: false }); E.ev.push({ tick: E.tick, k: 'loading' }); } return;
    case 'rstep': {
      const R = E.gun.reload;
      if (!R || !g.posted || g.busy || g.loaded || g.reserve <= 0 || !a.item) return;
      if (g.rIdx === 0 && (!E.reloads.length || E.reloads[E.reloads.length - 1].end != null)) { E.reloads.push({ start: E.tick, end: null, errors: 0, steps: true }); E.ev.push({ tick: E.tick, k: 'loading' }); }
      const cur = E.reloads[E.reloads.length - 1];
      if (R[g.rIdx].id !== a.item) { cur.errors++; E.ev.push({ tick: E.tick, k: 'reloadError', text: a.item }); return; }
      g.busy = 'rstep'; g.busyUntil = E.tick + sec(E, R[g.rIdx].sec); return;
    }
    case 'safety': g.safety = !!a.on; if (g.safety) g.trig = false; E.ev.push({ tick: E.tick, k: g.safety ? 'safetyOn' : 'safetyOff' }); return;
    case 'lay': if (tgt(E, a.cid)) { g.layCid = a.cid!; g.laidTick = null; } return;
    case 'slew': g.rAz = clamp(a.az ?? 0, -1, 1); g.rEl = clamp(a.el ?? 0, -1, 1); g.layCid = null; return;
    case 'trig': g.trig = !!a.on; return;
    case 'sight': g.sight = { spd: Math.max(0, a.spd ?? 0), crs: clamp(a.crs ?? 0, -180, 180), rng: clamp(a.rng ?? 1000, 100, 6000) }; g.sightTick = E.tick; return;
    case 'lock': g.lockCid = a.cid ?? null; g.lockStart = a.cid != null ? E.tick : null; if (a.cid != null) E.ev.push({ tick: E.tick, k: 'lock', cid: a.cid }); return;
    case 'clear': if (g.stoppage && !g.busy) { g.busy = 'clear'; g.busyUntil = E.tick + sec(E, P.stoppageClearSec); } return;
    case 'barrel': if (!g.busy) { g.busy = 'barrel'; g.busyUntil = E.tick + sec(E, P.barrelChangeSec); g.trig = false; } return;
    case 'unload': if (!g.busy && (g.loaded || g.ready > 0)) { g.busy = 'unload'; g.busyUntil = E.tick + sec(E, P.loadSec / 2); g.trig = false; } return;
    case 'report': g.reported = a.n ?? 0; g.reportTick = E.tick; E.ev.push({ tick: E.tick, k: 'report', n: a.n }); return;
  }
}

function spawn(E: GunEngine, sp: GunSpawn): void {
  const ty = E.C.threats.threats[sp.type], a = (sp.brg * Math.PI) / 180;
  const p0: Vec3 = [Math.sin(a) * sp.dist, Math.cos(a) * sp.dist, sp.alt];
  // Aim at a point `passM` to the side of the gun (0 = straight at it).
  const aim: Vec3 = [Math.cos(a) * sp.passM, -Math.sin(a) * sp.passM, sp.alt];
  const d = Math.hypot(aim[0] - p0[0], aim[1] - p0[1]), speed = ty.speed;
  const v: Vec3 = [((aim[0] - p0[0]) / d) * speed, ((aim[1] - p0[1]) / d) * speed, 0];
  const stand = ty.motion === 'approachHover' ? (ty.hoverRangeM?.[0] ?? 900) : ty.motion === 'surveil' ? (ty.orbitRadiusM?.[0] ?? 1400) : null;
  const hover = stand != null && ty.hostile ? Math.max(0, (sp.dist - stand) / speed) : null;
  E.targets.push({ id: E.targets.length + 1, type: sp.type, hostile: ty.hostile, spawnTick: E.tick, p0, v, weave: ty.motion === 'weave' ? 12 : 0,
    hoverAtSec: hover, orbitR: ty.motion === 'surveil' && stand != null ? stand : null, state: 'live', hits: 0, endTick: null, designatedTick: null });
}

function fire(E: GunEngine): void {
  const g = E.g, gun = E.gun, am = E.G.ammo[gun.ammo], t = E.tick * E.dt;
  const rate = (gun.barrels * gun.rpmPerBarrel) / 60;
  g.acc += rate * E.dt;
  let burst = E.bursts[E.bursts.length - 1];
  if (!burst || burst.end != null) {
    const on = targetOnLine(E, 6);
    burst = { start: E.tick, end: null, rounds: 0, cid: on?.id ?? null, authorised: authorised(E, on?.id ?? null), maxRangeM: 0, bestMiss: Infinity, hits: 0,
      safeArc: inSafeArc(E.cfg, g.az), afterHold: E.held, sight: g.sight ? { ...g.sight } : null,
      locked: g.lockCid != null && g.lockCid === (on?.id ?? -1) && g.lockStart != null && E.tick - g.lockStart >= sec(E, gun.radar?.lockSec ?? 0) };
    E.bursts.push(burst);
    E.ev.push({ tick: E.tick, k: burst.safeArc ? 'safeArcBurst' : burst.authorised ? 'burst' : 'unauthorisedBurst', cid: burst.cid ?? undefined });
  }
  const disp = (gun.dispMil * MIL) * (g.heat > gun.heatLimit ? 2 : 1);
  while (g.acc >= 1 && g.ready > 0 && !g.stoppage) {
    g.acc -= 1;
    const i = g.fired++;
    if (E.cfg.stoppages && hash2(E.cfg.seed * 13 + 7, i) < gun.stoppageP) { g.stoppage = true; g.trig = false; E.ev.push({ tick: E.tick, k: 'stoppage' }); break; }
    g.ready--; g.heat += gun.heatPerRound; if (g.heat > gun.heatLimit) g.overheatRounds++;
    const t0 = t; // all rounds of a tick leave on this tick (0.1 s resolution)
    const az = g.az + gauss(E.cfg.seed * 3 + 1, i) * disp / Math.max(0.2, Math.cos((g.el * Math.PI) / 180));
    const el = g.el + gauss(E.cfg.seed * 3 + 2, i) * disp;
    const mv = muzzleVelocity(am, E.cfg.met.tempC, E.G.met.stdTempC) + gauss(E.cfg.seed * 3 + 5, i) * am.mvSd;
    const dud = am.selfDestructSec > 0 && hash2(E.cfg.seed * 17 + 3, i) < am.sdFailP;
    let best: { cid: number; miss: number; tau: number } | null = null;
    for (const T of live(E)) {
      const L = losOf(targetPos(T, t, E.dt));
      if (Math.hypot(angDiff(L.az, az), L.el - el) > 10 || L.range > HORIZON_M) continue; // nowhere near the line of fire
      const tMax = am.selfDestructSec > 0 ? am.selfDestructSec : 8;
      const ap = closestApproach(am, { az, el, mv }, E.cfg.met, (tau) => targetPos(T, t0 + tau, E.dt), tMax, 0.01);
      if (!best || ap.miss < best.miss) best = { cid: T.id, miss: ap.miss, tau: ap.tau };
    }
    const T = best && tgt(E, best.cid), sz = T ? E.C.threats.threats[T.type].echo : '';
    const hit = !!(best && T && best.miss <= (E.G.targets.hitRadiusM[sz] ?? 0.4));
    E.rounds.push({ i, tick: E.tick, t0, az, el, mv, cid: best?.cid ?? null, miss: best?.miss ?? Infinity, tau: best?.tau ?? 0, hit, authorised: burst.authorised, dud });
    if (hit && best) E.pending.push({ tick: E.tick + Math.max(1, Math.ceil(best.tau / E.dt)), cid: best.cid });
    burst.rounds++;
    if (best && best.cid === burst.cid) { burst.bestMiss = Math.min(burst.bestMiss, best.miss); if (hit) burst.hits++; }
    const on = tgt(E, burst.cid);
    if (on) burst.maxRangeM = Math.max(burst.maxRangeM, losOf(targetPos(on, t, E.dt)).range);
  }
  if (g.ready <= 0) { g.loaded = false; g.trig = false; }
}

/** Advance one tick. Actions first (both seats), then the world, then the gun. */
export function stepGun(E: GunEngine, acts: GunAction[]): void {
  for (const a of acts) apply(E, a);
  const g = E.g, gun = E.gun, t = E.tick * E.dt;
  while (E.next < E.spawns.length && E.spawns[E.next].t <= t) spawn(E, E.spawns[E.next++]);
  // Busy jobs finish.
  if (g.busy && E.tick >= g.busyUntil) {
    const loadUp = () => { const n = Math.min(g.reserve, gun.beltRounds * gun.barrels); g.reserve -= n; g.ready += n; g.loaded = true; g.unloaded = false; E.ev.push({ tick: E.tick, k: 'loaded' }); const r = E.reloads[E.reloads.length - 1]; if (r && r.end == null) r.end = E.tick; };
    if (g.busy === 'post') { g.posted = true; E.ev.push({ tick: E.tick, k: 'posted' }); }
    else if (g.busy === 'load') loadUp();
    else if (g.busy === 'rstep') { E.ev.push({ tick: E.tick, k: 'rstep', text: gun.reload![g.rIdx].id }); if (++g.rIdx >= gun.reload!.length) { g.rIdx = 0; loadUp(); } }
    else if (g.busy === 'clear') { g.stoppage = false; E.ev.push({ tick: E.tick, k: 'cleared' }); }
    else if (g.busy === 'barrel') { g.heat = 0; E.ev.push({ tick: E.tick, k: 'barrelChanged' }); }
    else if (g.busy === 'unload') { g.reserve += g.ready; g.ready = 0; g.loaded = false; g.unloaded = true; E.ev.push({ tick: E.tick, k: 'unloaded' }); }
    g.busy = null;
  }
  // Laying: coarse lay on a designated target, powered radar laying on a lock, or the layer's handwheels.
  const sAz = gun.slewDegS.az * E.dt, sEl = gun.slewDegS.el * E.dt;
  let wantAz: number | null = null, wantEl: number | null = null;
  if (gun.sight === 'radar' && !E.cfg.radarFault && g.lockCid != null) { E.fcs = sightSolution(E, E.fcs); if (E.fcs?.ok) { wantAz = E.fcs.az; wantEl = E.fcs.el; } }
  else if (g.layCid != null) { const T = tgt(E, g.layCid); if (T && T.state === 'live') { const L = losOf(targetPos(T, t, E.dt)); wantAz = L.az; wantEl = L.el; } else g.layCid = null; }
  if (wantAz != null && wantEl != null) {
    const dA = angDiff(wantAz, g.az), dE = wantEl - g.el;
    g.az = (g.az + clamp(dA, -sAz, sAz) + 360) % 360; g.el += clamp(dE, -sEl, sEl);
    if (g.layCid != null && Math.abs(dA) < 1 && Math.abs(dE) < 1 && g.laidTick == null) { g.laidTick = E.tick; E.ev.push({ tick: E.tick, k: 'laid', cid: g.layCid }); g.layCid = null; }
  } else { g.az = (g.az + g.rAz * sAz + 360) % 360; g.el += g.rEl * sEl; }
  g.el = clamp(g.el, gun.elevDeg[0], gun.elevDeg[1]);
  g.heat = Math.max(0, g.heat - gun.coolPerSec * E.dt);
  // Firing.
  if (g.trig && g.loaded && !g.safety && !g.busy && !g.stoppage && g.ready > 0) fire(E);
  else { const b = E.bursts[E.bursts.length - 1]; if (b && b.end == null) b.end = E.tick; g.acc = 0; }
  // Hits land.
  for (const h of E.pending) if (h.tick === E.tick) {
    const T = tgt(E, h.cid);
    if (T && T.state === 'live' && ++T.hits >= (E.G.targets.hitsToKill[E.C.threats.threats[T.type].echo] ?? 1)) { T.state = 'destroyed'; T.endTick = E.tick; E.ev.push({ tick: E.tick, k: 'destroyed', cid: T.id }); }
  }
  // Targets reach the asset, or leave.
  const R0 = E.C.training.sim.assetRadiusM;
  for (const T of live(E)) {
    const p = targetPos(T, t, E.dt), h = Math.hypot(p[0], p[1]);
    if (T.hostile && h < R0) { T.state = 'leaked'; T.endTick = E.tick; E.ev.push({ tick: E.tick, k: 'leaked', cid: T.id }); }
    else if (h > HORIZON_M + 200) { T.state = 'gone'; T.endTick = E.tick; }
    else if (!T.hostile) { const s = t - T.spawnTick * E.dt; if (s > 2 && h > Math.hypot(T.p0[0], T.p0[1]) + 50) { T.state = 'gone'; T.endTick = E.tick; } }
  }
  // A friendly or civil aircraft near the line of fire while cleared: the control room must order HOLD FIRE.
  const nh = E.cleared != null && E.targets.some((T) => T.state === 'live' && !T.hostile && (() => { const L = losOf(targetPos(T, t, E.dt)); return Math.hypot(angDiff(L.az, g.az), L.el - g.el) < 5; })());
  if (nh && E.nhIn == null) { E.nhIn = E.tick; E.ev.push({ tick: E.tick, k: 'nonHostileInLine' }); }
  else if (!nh && E.nhIn != null && E.cleared != null) E.nhIn = null;
  E.tick++;
}

/** Engagement time limit, plus up to 90 s for making safe and the range sweep once UNLOAD is ordered. */
/** Reloads in a reload practice drill. */
export const RELOAD_REPS = 3;
export const gunMaxTicks = (E: GunEngine): number => sec(E, E.cfg.maxSec ?? 180) + (E.unloadOrdered ? sec(E, 90) : 0);
/** Range at which to open fire on this target: the size-based engagement range, capped by the gun's effective range. */
export const engageRange = (E: GunEngine, T: GunTarget): number => Math.min(E.gun.effRangeM, E.G.targets.engageRangeM?.[E.C.threats.threats[T.type].echo] ?? E.gun.effRangeM);
/** Drill over: every target resolved, cease fire given, and the gun unloaded and reported (or time is up). */
export function gunDone(E: GunEngine): boolean {
  if (E.tick >= gunMaxTicks(E)) return true;
  if (E.cfg.practice === 'reload') return E.reloads.filter((r) => r.end != null).length >= RELOAD_REPS;
  const resolved = E.next >= E.spawns.length && E.targets.every((t) => !t.hostile || t.state !== 'live');
  return resolved && E.ceased && E.g.reportTick != null && (!E.G.lfx || E.rangeGreenTick != null);
}
/** Unexploded rounds: rounds whose self-destruct failed and that did not hit a target. */
export const unexploded = (E: GunEngine): Round[] => E.rounds.filter((r) => r.dud && !r.hit);
/** Where an unexploded round came down (flown to the ground; coarse step, for the range sweep only). */
export function dudPoint(E: GunEngine, r: Round): Vec3 {
  let last: Vec3 = [0, 0, 0];
  fly(E.G.ammo[E.gun.ammo], { az: r.az, el: r.el, mv: r.mv }, E.cfg.met, { dt: 0.05, tMax: 90 }, (_t, p) => { last = [p[0], p[1], p[2]]; return p[2] < -5; });
  return last;
}

export interface GunRunOptions { actions?: GunAction[]; policies?: ((E: GunEngine) => GunAction[])[]; until?: number; stopWhenDone?: boolean; spawns?: GunSpawn[]; }
/** Re-run a gun drill from its config and action log (and/or policies). Pure and deterministic. */
export function runGun(cfg: GunDrillConfig, o: GunRunOptions = {}, C: Config = getConfig()): GunEngine {
  const E = createGun(cfg, C, o.spawns);
  const by = new Map<number, GunAction[]>();
  for (const a of o.actions ?? []) { const l = by.get(a.tick) ?? []; l.push(a); by.set(a.tick, l); }
  while (E.tick < (o.until ?? gunMaxTicks(E))) {
    const acts = (by.get(E.tick) ?? []).concat(...(o.policies ?? []).map((p) => p(E).map((a) => ({ ...a, tick: E.tick }))));
    stepGun(E, acts);
    if (o.stopWhenDone && gunDone(E)) break;
  }
  return E;
}
/** Drive a drill with policies, recording every action exactly as the live app does (for replays and the server). */
export function driveGun(E: GunEngine, policies: ((E: GunEngine) => GunAction[])[], stopWhenDone = true): GunAction[] {
  const log: GunAction[] = [];
  while (E.tick < gunMaxTicks(E)) {
    const acts = policies.flatMap((p) => p(E)).map((a) => ({ ...a, tick: E.tick }));
    log.push(...acts); stepGun(E, acts);
    if (stopWhenDone && gunDone(E)) break;
  }
  return log;
}
export { MIL, barrelDir };
