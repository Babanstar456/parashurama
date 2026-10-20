import { angDiff, dirOf, fly, losOf, type Met, type Vec3 } from './ballistics';
import { getConfig, gunsOf, type Ammo, type Config, type GunsFile } from './config';
import type { GunScore, GunPart } from './gunscore';
import type { Terrain, TimeOfDay } from './types';
import { clamp, mulberry } from './util';

/**
 * UAV ground-control-station strike drill (extension beyond the counter-drone PS; training model only).
 * Pre-flight checks → mission plan → take-off clearance → transit inside the safe corridor → find and lock the target with
 * the gimbal camera → CLEAR TO ENGAGE → Master Arm → release on the continuously computed impact point (free-fall
 * munition flown with the same ballistics engine, wind included) → battle damage assessment → Master Arm SAFE → return
 * along the inbound corridor → land, recover, clear the payload. Deterministic from seed + log, like the gun drills.
 */
export interface GcsCfg { seed: number; time: TimeOfDay; terrain: Terrain; met: Met; difficulty: number; maxSec?: number; }
export type UavPhase = 'ground' | 'takeoff' | 'transit' | 'loiter' | 'run' | 'egress' | 'return' | 'landing' | 'landed';
export type UavActionKind = 'check' | 'plan' | 'reqTakeoff' | 'takeoff' | 'direct' | 'gimbal' | 'lock' | 'reqEngage' | 'arm' | 'run' | 'steer' | 'release' | 'bda' | 'rth' | 'recover' | 'payloadClear';
export interface UavAction { tick: number; k: UavActionKind; item?: string; az?: number; el?: number; on?: boolean; deg?: number; out?: 'hit' | 'miss'; }
export interface GroundObj { id: number; p: Vec3; kind: 'target' | 'civil' | 'hut'; label: string; }
export interface UavEvent { tick: number; k: string; text?: string; }
export interface UavEngine {
  C: Config; G: GunsFile; U: NonNullable<GunsFile['uav']>; cfg: GcsCfg; tick: number; dt: number; phase: UavPhase;
  p: Vec3; hdg: number; steer: number; /** Attack run: 0 = to the IP, 1 = down the attack axis. */ runStage: number; out: Vec3[]; back: Vec3[]; wp: number; ip: Vec3; axis: number; village: Vec3; objs: GroundObj[]; target: GroundObj;
  checks: Record<string, number>; planTick: number | null; reqTakeoffTick: number | null; takeoffClearTick: number | null; takeoffTick: number | null; phaseTick: number;
  loiterTick: number | null; gim: { az: number; el: number; rAz: number; rEl: number }; lock: { id: number; tick: number } | null; civilLocked: boolean;
  reqEngageTick: number | null; engageClearTick: number | null; denied: number; arm: boolean; armTick: number | null; armedBeforeClearance: boolean;
  release: { tick: number; p: Vec3; cleared: boolean } | null; impact: { tick: number; p: Vec3; miss: number; hit: boolean } | null; bda: { tick: number; out: 'hit' | 'miss' } | null;
  safeTick: number | null; rthTick: number | null; landedTick: number | null; recoverTick: number | null; payloadClearTick: number | null;
  outside: boolean; breaches: number[]; ev: UavEvent[];
}
const sec = (E: UavEngine, s: number) => Math.round(s / E.dt);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const at = (brg: number, d: number, z = 0, from: Vec3 = [0, 0, 0]): Vec3 => { const v = dirOf(brg, 0); return [from[0] + v[0] * d, from[1] + v[1] * d, z]; };
const hd = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const brgTo = (a: Vec3, b: Vec3) => losOf(sub(b, a)).az;
/** Horizontal distance from a point to a polyline. */
function distToPath(p: Vec3, path: Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2, 0, 1);
    best = Math.min(best, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t));
  }
  return best;
}
export const defaultGcsCfg = (o: Partial<GcsCfg> = {}): GcsCfg => ({ seed: 1, time: 'day', terrain: 'rural', difficulty: 3, met: { tempC: 28, pressureHpa: 1000, wind: [4, -2, 0], latitudeDeg: 26 }, ...o });

export function createGcs(cfg: GcsCfg, C: Config = getConfig()): UavEngine {
  const G = gunsOf(C), U = G.uav;
  if (!U) throw new Error('This config has no UAV drill (guns.json uav)');
  const r = mulberry(cfg.seed * 11 + 5), alt = U.altM;
  const brg = Math.round(r() * 360), dist = 2600 + r() * 900, axis = (brg + (r() - 0.5) * 60 + 360) % 360;
  const T: Vec3 = at(brg, dist), ip: Vec3 = at((axis + 180) % 360, 900, alt, T);
  // The straight line to the IP crosses a village (no-fly): the safe corridor doglegs round it.
  const mid: Vec3 = [ip[0] / 2, ip[1] / 2, alt], side = r() < 0.5 ? 1 : -1, perp = dirOf(brgTo([0, 0, 0], ip) + 90 * side, 0);
  const wp1: Vec3 = [mid[0] + perp[0] * 750, mid[1] + perp[1] * 750, alt];
  const out: Vec3[] = [[0, 0, alt], wp1, ip];
  const civ = at((axis + 90 + (r() - 0.5) * 60) % 360, 70 + r() * 60, 0, T), hut = at((axis - 90 + (r() - 0.5) * 60 + 360) % 360, 90 + r() * 60, 0, T);
  const objs: GroundObj[] = [{ id: 1, p: T, kind: 'target', label: 'Hostile launch vehicle' }, { id: 2, p: civ, kind: 'civil', label: 'Civilian truck' }, { id: 3, p: hut, kind: 'hut', label: 'Empty hut' }];
  return {
    C, G, U, cfg, tick: 0, dt: C.training.sim.dt, phase: 'ground', runStage: 0, p: [0, 0, 0], hdg: brgTo([0, 0, 0], wp1), steer: 0, out, back: [ip, wp1, [0, 0, alt]], wp: 1, ip, axis,
    village: mid, objs, target: objs[0], checks: {}, planTick: null, reqTakeoffTick: null, takeoffClearTick: null, takeoffTick: null, phaseTick: 0, loiterTick: null,
    gim: { az: brgTo([0, 0, 0], wp1), el: -20, rAz: 0, rEl: 0 }, lock: null, civilLocked: false, reqEngageTick: null, engageClearTick: null, denied: 0,
    arm: false, armTick: null, armedBeforeClearance: false, release: null, impact: null, bda: null, safeTick: null, rthTick: null, landedTick: null, recoverTick: null,
    payloadClearTick: null, outside: false, breaches: [], ev: [],
  };
}
const ammo = (E: UavEngine): Ammo => ({ label: E.U.munition.label, massKg: E.U.munition.massKg, caliberM: E.U.munition.caliberM, mv: 0, mvSd: 0, mvPerDegC: 0, tracerSec: 0, selfDestructSec: 0, sdFailP: 0, cdMach: E.U.munition.cdMach });
/** Ground velocity of the UAV (air vector plus wind). */
export const uavVel = (E: UavEngine): Vec3 => { const v = dirOf(E.hdg, 0), s = E.phase === 'ground' || E.phase === 'landed' ? 0 : E.U.speed, w = E.cfg.met.wind; return [v[0] * s + w[0], v[1] * s + w[1], 0]; };
/** Continuously computed impact point: where the munition would land if released now (null on the ground). */
export function ccip(E: UavEngine): { p: Vec3; tof: number } | null {
  if (E.p[2] < 20) return null;
  const v = uavVel(E), L = losOf(v), mv = Math.hypot(v[0], v[1], v[2]);
  if (mv < 1) return null;
  let hit: Vec3 = [0, 0, 0], t = 0;
  fly(ammo(E), { az: L.az, el: L.el, mv }, E.cfg.met, { dt: 0.02, tMax: 60 }, (tt, p) => { hit = p; t = tt; return p[2] <= -E.p[2]; });
  return { p: [E.p[0] + hit[0], E.p[1] + hit[1], 0], tof: t };
}
/** Where the camera is looking on the ground (null if it points at the sky). */
export function gimbalGround(E: UavEngine): Vec3 | null {
  if (E.gim.el >= -1 || E.p[2] < 5) return null;
  const d = E.p[2] / Math.tan((-E.gim.el * Math.PI) / 180);
  return at(E.gim.az, d, 0, E.p);
}
function objOnBoresight(E: UavEngine, maxDeg: number): GroundObj | undefined {
  let best: GroundObj | undefined, bd = maxDeg;
  for (const o of E.objs) {
    const L = losOf(sub(o.p, E.p)), d = Math.hypot(angDiff(L.az, E.gim.az) * Math.cos((L.el * Math.PI) / 180), L.el - E.gim.el);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}
const allowed = (E: UavEngine) => distToPath(E.p, [...E.out, E.target.p]) <= E.U.corridorHalfWidthM || hd(E.p, E.target.p) <= 1300; // the target area (orbit and attack run)

function apply(E: UavEngine, a: UavAction): void {
  const U = E.U, ev = (k: string, text?: string) => E.ev.push({ tick: E.tick, k, text });
  switch (a.k) {
    case 'check': if (a.item && U.checks.some((c) => c.id === a.item) && E.checks[a.item] == null) { E.checks[a.item] = E.tick; ev('check', a.item); } return;
    case 'plan': if (E.planTick == null) { E.planTick = E.tick; ev('plan'); } return;
    case 'reqTakeoff': if (E.reqTakeoffTick == null && E.phase === 'ground') { E.reqTakeoffTick = E.tick; ev('reqTakeoff'); } return;
    case 'takeoff': if (E.phase === 'ground' && E.planTick != null) { E.phase = 'takeoff'; E.phaseTick = E.tick; E.takeoffTick = E.tick; ev(E.takeoffClearTick != null ? 'takeoff' : 'takeoffNoClearance'); } return;
    case 'direct': if (E.phase === 'transit' && E.wp === 1) { E.wp = 2; ev('direct'); } return;
    case 'gimbal': E.gim.rAz = clamp(a.az ?? 0, -1, 1); E.gim.rEl = clamp(a.el ?? 0, -1, 1); if (E.gim.rAz || E.gim.rEl) E.lock = null; return;
    case 'lock': { const o = objOnBoresight(E, U.gimbalFovDeg / 8); if (o) { E.lock = { id: o.id, tick: E.tick }; if (o.kind === 'civil') E.civilLocked = true; ev('lock', o.label); } else ev('lockFail'); return; }
    case 'reqEngage': if (E.lock && E.reqEngageTick == null && E.engageClearTick == null) { E.reqEngageTick = E.tick; ev('reqEngage'); } return;
    case 'arm': if (!!a.on !== E.arm) { E.arm = !!a.on; if (E.arm) { E.armTick = E.tick; if (E.engageClearTick == null) E.armedBeforeClearance = true; } else if (E.release && E.safeTick == null) E.safeTick = E.tick; ev(E.arm ? 'armOn' : 'armSafe'); } return;
    case 'run': if (E.phase === 'loiter') { E.phase = 'run'; E.phaseTick = E.tick; E.steer = 0; E.runStage = 0; ev('run'); } return;
    case 'steer': E.steer = clamp(a.deg ?? 0, -20, 20); return;
    case 'release': {
      if (E.release || E.p[2] < 50) return;
      if (!E.arm) { ev('releaseInterlock'); return; } // Master Arm interlock
      const c = ccip(E); if (!c) return;
      E.release = { tick: E.tick, p: [...E.p] as Vec3, cleared: E.engageClearTick != null };
      const miss = hd(c.p, E.target.p);
      E.impact = { tick: E.tick + Math.max(1, Math.round(c.tof / E.dt)), p: c.p, miss, hit: miss <= U.munition.lethalRadiusM };
      ev(E.release.cleared ? 'release' : 'releaseNoClearance'); return;
    }
    case 'bda': if (E.impact && E.tick >= E.impact.tick && !E.bda && a.out) { E.bda = { tick: E.tick, out: a.out }; ev('bda', a.out); } return;
    case 'rth': if (E.p[2] > 20 && E.phase !== 'return' && E.phase !== 'landing') { E.phase = 'return'; E.phaseTick = E.tick; E.wp = 0; E.rthTick = E.tick; ev('rth'); } return;
    case 'recover': if (E.phase === 'landed' && E.recoverTick == null) { E.recoverTick = E.tick; ev('recover'); } return;
    case 'payloadClear': if (E.phase === 'landed' && E.payloadClearTick == null) { E.payloadClearTick = E.tick; ev('payloadClear'); } return;
  }
}

/** Advance one tick: actions, range control and mission commander, then flight, gimbal and the corridor check. */
export function stepGcs(E: UavEngine, acts: UavAction[]): void {
  for (const a of acts) apply(E, a);
  const U = E.U, dt = E.dt;
  // Range control grants take-off after a short delay; the mission commander clears engagement only on the right target.
  if (E.reqTakeoffTick != null && E.takeoffClearTick == null && E.tick - E.reqTakeoffTick >= sec(E, U.clearanceSec)) { E.takeoffClearTick = E.tick; E.ev.push({ tick: E.tick, k: 'takeoffCleared' }); }
  if (E.reqEngageTick != null && E.engageClearTick == null && E.tick - E.reqEngageTick >= sec(E, U.clearanceSec)) {
    if (E.lock?.id === E.target.id) { E.engageClearTick = E.tick; E.ev.push({ tick: E.tick, k: 'engageCleared' }); }
    else { E.denied++; E.reqEngageTick = null; E.ev.push({ tick: E.tick, k: 'engageDenied' }); }
  }
  // Flight.
  const alt = U.altM, turn = U.turnDegS * dt;
  let want: Vec3 | null = null;
  if (E.phase === 'takeoff') {
    E.p[2] = Math.min(alt, E.p[2] + (alt / U.takeoffSec) * dt);
    if (E.tick - E.phaseTick >= sec(E, U.takeoffSec)) { E.phase = 'transit'; E.phaseTick = E.tick; E.ev.push({ tick: E.tick, k: 'airborne' }); }
    want = E.out[1];
  } else if (E.phase === 'transit') {
    want = E.out[E.wp];
    if (hd(E.p, want) < 80) { if (++E.wp >= E.out.length) { E.phase = 'loiter'; E.phaseTick = E.tick; E.loiterTick = E.tick; E.ev.push({ tick: E.tick, k: 'onStation' }); } }
  } else if (E.phase === 'loiter' || E.phase === 'egress') {
    // Orbit the target area at 700 m: aim at a point ahead on the circle.
    const th = Math.atan2(E.p[0] - E.target.p[0], E.p[1] - E.target.p[1]) + 0.35;
    want = [E.target.p[0] + Math.sin(th) * 700, E.target.p[1] + Math.cos(th) * 700, alt];
    if (E.phase === 'egress' && E.tick - E.phaseTick > sec(E, 8)) { E.phase = 'loiter'; E.phaseTick = E.tick; }
  } else if (E.phase === 'run') {
    // Attack run: to the IP, then down the attack axis over the target (cross-track held by the autopilot); the operator steers.
    if (E.runStage === 0) { want = E.ip; if (hd(E.p, E.ip) < 120) E.runStage = 1; }
    if (E.runStage === 1) {
      const ax = (E.axis * Math.PI) / 180, xt = (E.p[0] - E.target.p[0]) * Math.cos(ax) - (E.p[1] - E.target.p[1]) * Math.sin(ax); // + = right of the axis
      want = at((E.axis - clamp(xt * 0.15, -45, 45) + 360) % 360, 2000, alt, E.p);
    }
    const passed = (E.target.p[0] - E.p[0]) * Math.sin((E.axis * Math.PI) / 180) + (E.target.p[1] - E.p[1]) * Math.cos((E.axis * Math.PI) / 180) < -400;
    if (passed || (E.release && E.tick - E.release.tick > sec(E, 3))) { E.phase = 'egress'; E.phaseTick = E.tick; E.steer = 0; }
  } else if (E.phase === 'return') {
    want = E.back[E.wp];
    if (hd(E.p, want) < 80) { if (++E.wp >= E.back.length) { E.phase = 'landing'; E.phaseTick = E.tick; } }
  } else if (E.phase === 'landing') {
    E.p[2] = Math.max(0, E.p[2] - (alt / U.landSec) * dt);
    if (E.tick - E.phaseTick >= sec(E, U.landSec)) { E.phase = 'landed'; E.landedTick = E.tick; E.p[2] = 0; E.ev.push({ tick: E.tick, k: 'landed' }); }
  }
  if (want) {
    const target = (brgTo(E.p, want) + (E.phase === 'run' ? E.steer : 0) + 360) % 360;
    E.hdg = (E.hdg + clamp(angDiff(target, E.hdg), -turn, turn) + 360) % 360;
  }
  if (E.phase !== 'ground' && E.phase !== 'landed') { const v = uavVel(E); E.p[0] += v[0] * dt; E.p[1] += v[1] * dt; }
  // Gimbal: tracks a locked object, otherwise the operator's slew.
  const g = E.gim, sl = U.gimbalSlewDegS * dt;
  const lo = E.lock && E.objs.find((o) => o.id === E.lock!.id);
  if (lo && E.p[2] > 5) { const L = losOf(sub(lo.p, E.p)); g.az = L.az; g.el = L.el; }
  else { g.az = (g.az + g.rAz * sl + 360) % 360; g.el = clamp(g.el + g.rEl * sl, -90, 0); }
  // Corridor and geofence.
  if (E.p[2] > 20 && E.phase !== 'landing') {
    const out = !allowed(E);
    if (out && !E.outside) { E.breaches.push(E.tick); E.ev.push({ tick: E.tick, k: 'breach' }); }
    E.outside = out;
  }
  if (E.impact && E.tick === E.impact.tick) E.ev.push({ tick: E.tick, k: 'impact', text: E.impact.hit ? 'hit' : 'miss' });
  E.tick++;
}
export const gcsMaxTicks = (E: UavEngine) => sec(E, E.cfg.maxSec ?? 420);
export const gcsDone = (E: UavEngine) => E.tick >= gcsMaxTicks(E) || (E.phase === 'landed' && E.recoverTick != null && E.payloadClearTick != null);
export function runGcs(cfg: GcsCfg, o: { actions?: UavAction[]; policy?: (E: UavEngine) => UavAction[]; until?: number; stopWhenDone?: boolean } = {}, C: Config = getConfig()): UavEngine {
  const E = createGcs(cfg, C), by = new Map<number, UavAction[]>();
  for (const a of o.actions ?? []) { const l = by.get(a.tick) ?? []; l.push(a); by.set(a.tick, l); }
  while (E.tick < (o.until ?? gcsMaxTicks(E))) {
    const acts = (by.get(E.tick) ?? []).concat(o.policy ? o.policy(E).map((a) => ({ ...a, tick: E.tick })) : []);
    stepGcs(E, acts);
    if (o.stopWhenDone && gcsDone(E)) break;
  }
  return E;
}

/** Expert operator: every step in order, the corridor kept, the right target, release on the impact point, safe at once. */
export function uavAI(E: UavEngine): UavAction[] {
  const a = (x: Omit<UavAction, 'tick'>): UavAction[] => [{ tick: E.tick, ...x }];
  const todo = E.U.checks.find((c) => E.checks[c.id] == null);
  if (todo) return a({ k: 'check', item: todo.id });
  if (E.planTick == null) return a({ k: 'plan' });
  if (E.phase === 'ground' && E.landedTick == null) return E.reqTakeoffTick == null ? a({ k: 'reqTakeoff' }) : E.takeoffClearTick != null ? a({ k: 'takeoff' }) : [];
  if (E.phase === 'landed') return E.recoverTick == null ? a({ k: 'recover' }) : E.payloadClearTick == null ? a({ k: 'payloadClear' }) : [];
  if (E.phase === 'transit' || E.phase === 'takeoff' || E.phase === 'return' || E.phase === 'landing') return [];
  // On station: slew the camera to the target, lock, ask for clearance, arm, run in, steer, release, safe, assess, go home.
  if (!E.lock || E.lock.id !== E.target.id) {
    const L = losOf(sub(E.target.p, E.p)), dA = angDiff(L.az, E.gim.az), dE = L.el - E.gim.el, s = E.U.gimbalSlewDegS * E.dt;
    if (Math.hypot(dA, dE) < E.U.gimbalFovDeg / 10) return a({ k: 'lock' });
    const rAz = clamp(dA / s, -1, 1), rEl = clamp(dE / s, -1, 1);
    return Math.abs(rAz - E.gim.rAz) > 1e-3 || Math.abs(rEl - E.gim.rEl) > 1e-3 ? a({ k: 'gimbal', az: +rAz.toFixed(3), el: +rEl.toFixed(3) }) : [];
  }
  if (E.engageClearTick == null) return E.reqEngageTick == null ? a({ k: 'reqEngage' }) : [];
  if (!E.release) {
    if (!E.arm) return a({ k: 'arm', on: true });
    if (E.phase === 'loiter') return a({ k: 'run' });
    if (E.phase === 'run' && E.runStage === 1) {
      const c = ccip(E); if (!c) return [];
      const ax = (E.axis * Math.PI) / 180, u: [number, number] = [Math.sin(ax), Math.cos(ax)], d: [number, number] = [E.target.p[0] - c.p[0], E.target.p[1] - c.p[1]];
      const along = d[0] * u[0] + d[1] * u[1], cross = d[0] * u[1] - d[1] * u[0];
      if (along <= E.U.speed * E.dt * 0.6 && along > -40 && Math.abs(cross) < 15) return a({ k: 'release' });
      const want = clamp(E.steer + cross * 0.05, -20, 20); // cross > 0: target right of the impact point → steer right
      return Math.abs(want - E.steer) > 0.05 ? a({ k: 'steer', deg: +want.toFixed(2) }) : [];
    }
    return [];
  }
  if (E.arm) return a({ k: 'arm', on: false });
  if (E.impact && E.tick >= E.impact.tick + sec(E, 2) && !E.bda) return a({ k: 'bda', out: E.impact.hit ? 'hit' : 'miss' });
  if (E.bda && E.rthTick == null) return a({ k: 'rth' });
  return [];
}

/** Score the strike drill (U1–U9). */
export function scoreGcs(E: UavEngine): GunScore {
  const S = (t: number) => t * E.dt, lin = (x: number, f: number, z: number) => clamp(1 - (x - f) / (z - f), 0, 1);
  const part = (rule: string, label: string, max: number, frac: number, why: string[]): GunPart => ({ rule, label, max, pts: Math.round(max * clamp(frac, 0, 1)), why });
  const U = E.U, w5: string[] = [], w6: string[] = [], w7: string[] = [], w8: string[] = [], w9: string[] = [];
  const u5 = E.impact ? (E.impact.hit ? 1 : lin(E.impact.miss, U.munition.lethalRadiusM, 60)) : 0;
  if (!E.impact) w5.push('No release'); else w5.push(`Impact ${E.impact.miss.toFixed(1)} m from the target (lethal radius ${U.munition.lethalRadiusM} m)${E.impact.hit ? ': target destroyed' : ''}`);
  const lockT = E.ev.find((e) => e.k === 'lock' && E.lock?.id === E.target.id && e.text === E.target.label);
  let u6 = E.loiterTick == null ? 0 : lockT ? lin(S(lockT.tick - E.loiterTick), 20, 90) : 0;
  if (!lockT) w6.push('The target was never locked'); else if (S(lockT.tick - (E.loiterTick ?? 0)) > 20) w6.push(`Target locked ${S(lockT.tick - (E.loiterTick ?? 0)).toFixed(0)} s after arriving on station`);
  if (E.civilLocked) { u6 *= 0.5; w6.push('Locked a civilian vehicle'); }
  if (E.denied) w6.push(`Engagement refused ${E.denied} time(s): wrong object locked`);
  const u7 = E.bda && E.impact ? (E.bda.out === (E.impact.hit ? 'hit' : 'miss') ? lin(S(E.bda.tick - E.impact.tick), 15, 60) : 0) : E.impact ? 0 : 0;
  if (E.impact && !E.bda) w7.push('No damage assessment reported'); else if (E.bda && E.impact && E.bda.out !== (E.impact.hit ? 'hit' : 'miss')) w7.push(`Reported ${E.bda.out}; it was a ${E.impact.hit ? 'hit' : 'miss'}`);
  const u8 = E.release ? (E.safeTick != null ? lin(S(E.safeTick - E.release.tick), 5, 30) : 0) : E.arm ? 0 : 1;
  if (E.release && E.safeTick == null) w8.push('Master Arm left on after release'); else if (E.release && E.safeTick != null && S(E.safeTick - E.release.tick) > 5) w8.push(`Master Arm SAFE ${S(E.safeTick - E.release.tick).toFixed(0)} s after release`);
  const items = [E.rthTick != null && (E.bda != null || !E.impact), E.landedTick != null, E.recoverTick != null, E.payloadClearTick != null];
  ['Return before the assessment was reported, or no return', 'Not landed', 'Aircraft not recovered', 'Payload not cleared'].forEach((t, i) => { if (!items[i]) w9.push(t); });
  const parts = [part('U5', 'Release accuracy', 35, u5, w5), part('U6', 'Find and lock the target', 20, u6, w6), part('U7', 'Damage assessment', 10, u7, w7),
    part('U8', 'Master Arm SAFE after release', 15, u8, w8), part('U9', 'Return, land, recover, clear', 20, items.filter(Boolean).length / 4, w9)];
  const missing = U.checks.filter((c) => E.checks[c.id] == null || (E.reqTakeoffTick != null && E.checks[c.id] > E.reqTakeoffTick));
  const d: GunPart[] = [
    { rule: 'U1', label: 'Pre-flight checks', max: 0, pts: -4 * missing.length || 0, why: missing.map((c) => `Not done before asking for take-off: ${c.label} −4`) },
    { rule: 'U2', label: 'Take-off clearance', max: 0, pts: E.ev.some((e) => e.k === 'takeoffNoClearance') ? -20 : 0, why: E.ev.some((e) => e.k === 'takeoffNoClearance') ? ['Took off without clearance from range control −20'] : [] },
    { rule: 'U3', label: 'Corridor and geofence', max: 0, pts: -10 * E.breaches.length || 0, why: E.breaches.map((t) => `Left the safe corridor at ${S(t).toFixed(0)} s −10`) },
    { rule: 'U4', label: 'Weapons release authority', max: 0, pts: (E.release && !E.release.cleared ? -40 : 0) + (E.armedBeforeClearance ? -10 : 0) || 0,
      why: [...(E.release && !E.release.cleared ? ['Released without CLEAR TO ENGAGE −40'] : []), ...(E.armedBeforeClearance ? ['Master Arm on before CLEAR TO ENGAGE −10'] : [])] },
  ];
  const sum = parts.reduce((s, p) => s + p.pts, 0) + d.reduce((s, p) => s + p.pts, 0);
  const why = [...parts, ...d].flatMap((p) => p.why.map((w) => `${p.rule}: ${w}`));
  return { game: 'control', total: clamp(Math.round(sum), 0, 100), parts, deductions: d, why, rules: [...new Set([...parts, ...d].filter((p) => p.why.length).map((p) => p.rule))],
    metrics: { roundsFired: E.release ? 1 : 0, hits: E.impact?.hit ? 1 : 0, kills: E.impact?.hit ? 1 : 0, hostiles: 1, leaked: 0, ammoPerKill: E.impact?.hit ? 1 : null, violations: d.reduce((s, x) => s + x.why.length, 0), killRatePct: E.impact?.hit ? 100 : 0 } };
}
