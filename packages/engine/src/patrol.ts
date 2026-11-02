import { angDiff, closestApproach, fly, gauss, losOf, muzzleVelocity, solveAim, type AimSolution, type Met, type Vec3 } from './ballistics';
import { detectOf, fcsOf, getConfig, gunsOf, weatherFx, type Ammo, type Config, type Gun, type GunsFile } from './config';
import type { GunPart } from './gunscore';
import type { TimeOfDay, Weather } from './types';
import { clamp, mulberry } from './util';

/**
 * Urban patrol drill: the trainee commands a ZSU-23-4 on the move through a built-up area. Drive the patrol route,
 * find the drones that pop up over the rooftops, report and identify each one, lock the radar and engage only what is
 * positively identified hostile, without putting rounds into the buildings or hitting civilian traffic.
 * Separate from the gun drills (own records, own rules P1–P9), but the same ammunition, ballistics, threat library and
 * detection model. Deterministic: a drill is fully defined by its config, its world and its time-stamped action log.
 * Engine frame: x east, y north, z up (metres); bearings clockwise from north. Vehicle and drill values are training
 * values, not equipment specifications.
 */
export interface PatrolWorld {
  /** Half-size of the play area and its centre (engine frame). */ half: number; centre: [number, number];
  /** Buildings: [x0, y0, x1, y1, height]. */ boxes: number[][];
  /** Free-standing walls, fences and barriers: [x0, y0, x1, y1, height]. */ walls: number[][];
  /** Poles, trees and parked vehicles: [x, y, radius]. */ posts: number[][];
  /** Civilian traffic lanes: [x0, y0, x1, y1, road width]. */ lanes: number[][];
  /** Drivable road centre lines: [x0, y0, x1, y1, road width]. */ roads: number[][];
  landmarks: { name: string; x: number; y: number }[];
}
export interface PatrolCfg {
  seed: number; time: TimeOfDay; weather?: Weather; difficulty: number; met: Met;
  /** Time limit (s); missing = 240. */ maxSec?: number;
  /** Rounds issued; missing = 3000. */ issueRounds?: number;
  /** Weapon Control Status: tight = only identified hostiles; free = anything not identified friendly, civil or a bird. Missing = tight. */ wcs?: 'tight' | 'free';
  /** Number of patrol checkpoints; missing = 3. */ checkpoints?: number;
}
export type PatrolActionKind = 'drive' | 'slew' | 'trig' | 'lock' | 'spot' | 'ident' | 'load';
export interface PatrolAction { tick: number; k: PatrolActionKind; thr?: number; str?: number; az?: number; el?: number; on?: boolean; cid?: number; cls?: string; }
export type PGoal = 'hunt' | 'asset' | 'orbit' | 'wander';
export interface PTarget {
  id: number; type: string; hostile: boolean; spawnTick: number; p: Vec3; prev: Vec3; v: Vec3; goal: PGoal; gx: number; gy: number; gz: number; orbitR: number;
  /** Seconds spent orbiting overhead (recon: after 45 s it has fixed the patrol for the enemy's fires). */ orbitSec: number;
  state: 'live' | 'destroyed' | 'leaked' | 'gone'; hits: number; endTick: number | null; leakKind?: 'vehicle' | 'asset' | 'observed';
}
export interface PSpawn { type: string; t: number; brg: number; dist: number; alt: number; goal: PGoal; gi: number; }
export interface PRound { i: number; tick: number; o: Vec3; az: number; el: number; mv: number; cid: number | null; miss: number; tau: number; hit: boolean; bt: number | null; bp: Vec3 | null; }
export interface PBurst { start: number; end: number | null; rounds: number; cid: number | null; ok: boolean; nonHostile: boolean; }
export interface PEvent { tick: number; k: string; cid?: number; n?: number; text?: string; }
/** Civilian car: shuttles along its lane (s = distance round the out-and-back loop); waits while the patrol blocks its way. */
export interface PCar { lane: number; speed: number; s: number; len: number; waiting: boolean; }
export interface PatrolEngine {
  C: Config; G: GunsFile; gun: Gun; am: Ammo; cfg: PatrolCfg; W: PatrolWorld; tick: number; dt: number;
  veh: { x: number; y: number; hdg: number; v: number; thr: number; str: number; odo: number; contact: boolean; hits: number };
  g: { az: number; el: number; rAz: number; rEl: number; trig: boolean; ready: number; reserve: number; busyUntil: number | null; heat: number; acc: number; fired: number;
    lockCid: number | null; lockStart: number | null; lockBlocked: number };
  /** Patrol route along the road centre lines, checkpoints (route indices), those reached, and the next route point. */
  route: [number, number][]; cps: number[]; cpDone: number[]; wp: number;
  spawns: PSpawn[]; next: number; targets: PTarget[]; cars: PCar[];
  rounds: PRound[]; bursts: PBurst[]; pending: { tick: number; cid: number }[]; ev: PEvent[]; fcs: AimSolution | null;
  seen: Record<number, number>; spots: Record<number, number>; idents: { tick: number; cid: number; cls: string }[];
  collisions: { tick: number; kind: 'building' | 'car'; speed: number }[];
  /** Spatial grid over the obstacles (built once). */ grid: { x0: number; y0: number; n: number; cell: number; cells: number[][]; rects: number[][]; posts: number[][]; maxTop: number };
}

/** ZSU-23-4 on the move (training values). */
export const VEH = { halfW: 1.6, halfL: 3.35, vMax: 12, vRev: 4, acc: 1.8, brake: 5, turnDegS: 34, turnHiDegS: 16, trunnionM: 2.0, eyeM: 3.2, moveDisp: 0.8 };
const HORIZON_M = 4000;
const sec = (E: PatrolEngine, s: number) => Math.round(s / E.dt);

export const defaultPatrolCfg = (o: Partial<PatrolCfg> = {}): PatrolCfg => ({ seed: 1, time: 'day', difficulty: 3, met: { tempC: 30, pressureHpa: 1005, wind: [0, 0, 0], latitudeDeg: 26 }, ...o });

// ---------- world queries ----------
function buildGrid(W: PatrolWorld): PatrolEngine['grid'] {
  const cell = 16, ext = W.half + 60, x0 = W.centre[0] - ext, y0 = W.centre[1] - ext, n = Math.ceil((2 * ext) / cell);
  const rects = [...W.boxes.map((b) => [...b, 0]), ...W.walls.map((b) => [...b, 1])], cells: number[][] = Array.from({ length: n * n }, () => []);
  const put = (ax: number, ay: number, bx: number, by: number, v: number) => {
    for (let j = Math.max(0, Math.floor((ay - y0) / cell)); j <= Math.min(n - 1, Math.floor((by - y0) / cell)); j++)
      for (let i = Math.max(0, Math.floor((ax - x0) / cell)); i <= Math.min(n - 1, Math.floor((bx - x0) / cell)); i++) cells[j * n + i].push(v);
  };
  rects.forEach((r, k) => put(r[0], r[1], r[2], r[3], k));
  W.posts.forEach((p, k) => put(p[0] - p[2], p[1] - p[2], p[0] + p[2], p[1] + p[2], -1 - k));
  return { x0, y0, n, cell, cells, rects, posts: W.posts, maxTop: Math.max(0, ...W.boxes.map((b) => b[4])) };
}
function near(E: PatrolEngine, x: number, y: number, r: number): Set<number> {
  const G = E.grid, out = new Set<number>();
  for (let j = Math.max(0, Math.floor((y - r - G.y0) / G.cell)); j <= Math.min(G.n - 1, Math.floor((y + r - G.y0) / G.cell)); j++)
    for (let i = Math.max(0, Math.floor((x - r - G.x0) / G.cell)); i <= Math.min(G.n - 1, Math.floor((x + r - G.x0) / G.cell)); i++) for (const v of G.cells[j * G.n + i]) out.add(v);
  return out;
}
/** Oriented box (centre, heading, half width, half length) against an oriented box, separating axes. */
function obbHit(ax: number, ay: number, ah: number, aw: number, al: number, bx: number, by: number, bh: number, bw: number, bl: number): boolean {
  const A = [[Math.sin(ah), Math.cos(ah)], [Math.cos(ah), -Math.sin(ah)]], B = [[Math.sin(bh), Math.cos(bh)], [Math.cos(bh), -Math.sin(bh)]];
  const dx = bx - ax, dy = by - ay;
  for (const u of [...A, ...B]) {
    const ra = al * Math.abs(A[0][0] * u[0] + A[0][1] * u[1]) + aw * Math.abs(A[1][0] * u[0] + A[1][1] * u[1]);
    const rb = bl * Math.abs(B[0][0] * u[0] + B[0][1] * u[1]) + bw * Math.abs(B[1][0] * u[0] + B[1][1] * u[1]);
    if (Math.abs(dx * u[0] + dy * u[1]) > ra + rb) return false;
  }
  return true;
}
/** Position and heading (rad) of a civilian car: out along its lane on one side of the road, back on the other. */
export function carPose(E: PatrolEngine, c: PCar, s0 = c.s): { x: number; y: number; h: number } {
  const L = E.W.lanes[c.lane], len = Math.hypot(L[2] - L[0], L[3] - L[1]), ux = (L[2] - L[0]) / len, uy = (L[3] - L[1]) / len;
  const s = ((s0 % (2 * len)) + 2 * len) % (2 * len), fwd = s < len, d = fwd ? s : 2 * len - s, off = (L[4] / 4) * (fwd ? 1 : -1);
  return { x: L[0] + ux * d + uy * off, y: L[1] + uy * d - ux * off, h: Math.atan2(fwd ? ux : -ux, fwd ? uy : -uy) };
}
/** Does the vehicle at this pose touch anything solid? Returns 'car', 'building' or null. */
export function hullBlocked(E: PatrolEngine, x: number, y: number, hdgDeg: number): 'building' | 'car' | null {
  const h = (hdgDeg * Math.PI) / 180, { halfW: w, halfL: l } = VEH, W = E.W;
  if (Math.abs(x - W.centre[0]) > W.half - 4 || Math.abs(y - W.centre[1]) > W.half - 4) return 'building';
  for (const k of near(E, x, y, l + 1)) {
    if (k >= 0) { const r = E.grid.rects[k]; if (obbHit(x, y, h, w, l, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2, 0, (r[2] - r[0]) / 2, (r[3] - r[1]) / 2)) return 'building'; }
    else {
      const p = E.grid.posts[-1 - k], dx = p[0] - x, dy = p[1] - y, f = dx * Math.sin(h) + dy * Math.cos(h), s = dx * Math.cos(h) - dy * Math.sin(h);
      if (Math.hypot(f - clamp(f, -l, l), s - clamp(s, -w, w)) < p[2]) return 'building';
    }
  }
  for (const c of E.cars) { const p = carPose(E, c); if (Math.hypot(p.x - x, p.y - y) < 8 && obbHit(x, y, h, w, l, p.x, p.y, p.h, 0.95, c.len / 2)) return 'car'; }
  return null;
}
/** First crossing of the segment a→b (world) with a building or wall: fraction 0…1, or null. */
export function segBlocked(E: PatrolEngine, a: Vec3, b: Vec3, wallsToo = true): number | null {
  const G = E.grid, x1 = G.x0 + G.n * G.cell, y1 = G.y0 + G.n * G.cell;
  if (Math.min(a[2], b[2]) > G.maxTop + 1) return null;
  const cand = new Set<number>(), L = Math.hypot(b[0] - a[0], b[1] - a[1]), steps = Math.max(1, Math.ceil(L / (G.cell * 0.5)));
  for (let s = 0; s <= steps; s++) {
    const f = s / steps, x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f, z = a[2] + (b[2] - a[2]) * f;
    if (x < G.x0 || y < G.y0 || x >= x1 || y >= y1 || z > G.maxTop + G.cell) continue;
    for (const v of G.cells[Math.floor((y - G.y0) / G.cell) * G.n + Math.floor((x - G.x0) / G.cell)]) if (v >= 0) cand.add(v);
  }
  let best: number | null = null;
  for (const k of cand) {
    const r = G.rects[k]; if (!wallsToo && r[5] === 1) continue;
    let t0 = 0, t1 = 1;
    const lo = [r[0], r[1], 0], hi = [r[2], r[3], r[4]];
    for (let i = 0; i < 3 && t0 <= t1; i++) {
      const d = b[i] - a[i];
      if (Math.abs(d) < 1e-9) { if (a[i] < lo[i] || a[i] > hi[i]) t1 = -1; continue; }
      let u = (lo[i] - a[i]) / d, w = (hi[i] - a[i]) / d; if (u > w) [u, w] = [w, u];
      t0 = Math.max(t0, u); t1 = Math.min(t1, w);
    }
    if (t0 <= t1 && (best == null || t0 < best)) best = t0;
  }
  return best;
}
/** The gun's origin (trunnion) in the world. */
export const gunOrigin = (E: PatrolEngine): Vec3 => [E.veh.x, E.veh.y, VEH.trunnionM];
export const eyeOf = (E: PatrolEngine): Vec3 => [E.veh.x, E.veh.y, VEH.eyeM];
const rel = (p: Vec3, o: Vec3): Vec3 => [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
/** Target position at a fraction of the current tick (for drawing), world frame. */
export const pTargetAt = (T: PTarget, f: number): Vec3 => [T.prev[0] + (T.p[0] - T.prev[0]) * f, T.prev[1] + (T.p[1] - T.prev[1]) * f, T.prev[2] + (T.p[2] - T.prev[2]) * f];

// ---------- detection ----------
export function pDetectRangeM(E: PatrolEngine, T: PTarget): number {
  const D = detectOf(E.G), size = E.C.threats.threats[T.type].echo, wx = weatherFx(E.C, E.cfg.weather);
  let r = (D.visualM[size] ?? 1000) * (E.cfg.time === 'night' ? D.night : 1) * wx.camera * D.urban;
  const s = fcsOf(E.gun);
  if (s) r = Math.max(r, s.acquireRangeM * (D.sensorBySize[size] ?? 1) * wx.radar * D.urban);
  return r;
}
/** Line of sight from the commander's eye to the target, clear of buildings. */
export const pClear = (E: PatrolEngine, T: PTarget): boolean => segBlocked(E, eyeOf(E), T.p, false) == null;
/** Can the crew see (eye or radar) this target now: in range and not hidden behind a building? */
export function pVisible(E: PatrolEngine, T: PTarget): boolean {
  if (T.state !== 'live') return false;
  const L = losOf(rel(T.p, eyeOf(E)));
  return L.range <= pDetectRangeM(E, T) && L.el > -10 && pClear(E, T);
}
export const pIdentOf = (E: PatrolEngine, cid: number): string | null => { for (let i = E.idents.length - 1; i >= 0; i--) if (E.idents[i].cid === cid) return E.idents[i].cls; return null; };
/** May the crew fire on this target under the drill's Weapon Control Status? */
export function pCleared(E: PatrolEngine, cid: number | null): boolean {
  if (cid == null) return false;
  const c = pIdentOf(E, cid), th = c && c !== 'unknown' ? E.C.threats.threats[c] : null;
  return (E.cfg.wcs ?? 'tight') === 'free' ? !th || th.hostile : !!th?.hostile;
}

// ---------- scenario ----------
/** Road network nodes (intersections and ends) and a patrol route along it, from the seed. */
function buildRoute(W: PatrolWorld, r: () => number, nCp: number): { route: [number, number][]; cps: number[] } {
  // Wide roads have a central reservation (lamp posts, palms): the patrol keeps to the northern / eastern carriageway.
  // Only roads a 6.7 m tracked hull can turn into (the old-town lanes are too tight for a junction turn).
  const R = W.roads.filter((a) => a[4] >= 9).map((a) => (a[4] < 20 ? a : a[1] === a[3] ? [a[0], a[1] + a[4] / 4, a[2], a[3] + a[4] / 4, a[4] / 2] : [a[0] + a[4] / 4, a[1], a[2] + a[4] / 4, a[3], a[4] / 2]));
  if (!R.length) return { route: [[W.centre[0], W.centre[1]]], cps: [] };
  // Nodes along each road: its ends and every crossing with another road.
  const on: [number, number][][] = R.map((a) => [[a[0], a[1]], [a[2], a[3]]]);
  for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
    const a = R[i], b = R[j], ah = a[1] === a[3], bh = b[1] === b[3];
    if (ah === bh) continue;
    const h = ah ? a : b, v = ah ? b : a, x = v[0], y = h[1];
    const inH = x >= Math.min(h[0], h[2]) - v[4] / 2 && x <= Math.max(h[0], h[2]) + v[4] / 2, inV = y >= Math.min(v[1], v[3]) - h[4] / 2 && y <= Math.max(v[1], v[3]) + h[4] / 2;
    if (!inH || !inV) continue;
    on[ah ? i : j].push([clamp(x, Math.min(h[0], h[2]), Math.max(h[0], h[2])), y]); on[ah ? j : i].push([x, clamp(y, Math.min(v[1], v[3]), Math.max(v[1], v[3]))]);
  }
  const nodes: [number, number][] = [], key = (p: [number, number]) => { const k = nodes.findIndex((n) => Math.hypot(n[0] - p[0], n[1] - p[1]) < 10); return k >= 0 ? k : nodes.push(p) - 1; };
  const adj = new Map<number, Set<number>>();
  on.forEach((pts, i) => {
    const a = R[i], hz = a[1] === a[3];
    const ids = pts.sort((p, q) => (hz ? p[0] - q[0] : p[1] - q[1])).map(key);
    for (let k = 0; k + 1 < ids.length; k++) if (ids[k] !== ids[k + 1]) { (adj.get(ids[k]) ?? adj.set(ids[k], new Set()).get(ids[k])!).add(ids[k + 1]); (adj.get(ids[k + 1]) ?? adj.set(ids[k + 1], new Set()).get(ids[k + 1])!).add(ids[k]); }
  });
  // Start at a junction on the widest road (room to manoeuvre), then a random walk that never doubles back; a
  // checkpoint about every 110 m.
  const wide = R.reduce((b, a) => (a[4] > b[4] ? a : b)), onWide = [...adj.keys()].filter((k) => (adj.get(k)!.size >= 2) && (wide[1] === wide[3] ? Math.abs(nodes[k][1] - wide[1]) < 1 : Math.abs(nodes[k][0] - wide[0]) < 1));
  const starts = onWide.length ? onWide : [...adj.keys()];
  let cur = starts[Math.floor(r() * starts.length)];
  const path = [cur], used = new Set([cur]), cps: number[] = [];
  let dist = 0, sinceCp = 0;
  for (let step = 0; step < 60 && cps.length < nCp; step++) {
    const opts = [...(adj.get(cur) ?? [])].filter((n) => !used.has(n));
    if (!opts.length) break;
    const nx = opts[Math.floor(r() * opts.length)], d = Math.hypot(nodes[nx][0] - nodes[cur][0], nodes[nx][1] - nodes[cur][1]);
    dist += d; sinceCp += d; path.push(nx); used.add(nx); cur = nx;
    if (sinceCp >= 110) { cps.push(path.length - 1); sinceCp = 0; }
  }
  if (!cps.length && path.length > 1) cps.push(path.length - 1);
  return { route: path.map((k) => nodes[k]), cps };
}
export function buildPatrolScenario(cfg: PatrolCfg, W: PatrolWorld, C: Config = getConfig()): PSpawn[] {
  const r = mulberry(cfg.seed * 13 + 4409), T = C.threats.threats, d = clamp(cfg.difficulty, 1, 5), out: PSpawn[] = [];
  const hunters = ['fpv', 'fibre'].filter((k) => T[k]), strikers = ['aiStrike', 'dropper', 'loiter'].filter((k) => T[k]), watchers = ['recon', 'vtol'].filter((k) => T[k]);
  const nAsset = Math.max(1, W.landmarks.length);
  let t = 8;
  const n = 3 + Math.floor(d / 2);
  for (let i = 0; i < n; i++) {
    const roll = r(), kind: PGoal = roll < 0.45 ? 'hunt' : roll < 0.8 ? 'asset' : 'orbit';
    const pool = kind === 'hunt' ? hunters : kind === 'asset' ? strikers : watchers, type = pool[Math.floor(r() * pool.length)] ?? 'fpv', ty = T[type];
    // Urban: they come in low over the rooftops (hidden until they clear the buildings in between); hunters need to see
    // the patrol, so they cruise a little higher and dive only when nearly overhead.
    const alt = clamp(ty.alt[0] + r() * (ty.alt[1] - ty.alt[0]), kind === 'hunt' ? 40 : 25, kind === 'orbit' ? 160 : 75);
    out.push({ type, t, brg: Math.round(r() * 359), dist: clamp(ty.speed * (24 + r() * 10), 700, 1500), alt, goal: kind, gi: Math.floor(r() * nAsset) });
    t += 20 - 2 * d + r() * 6;
  }
  if (d >= 4 && T.swarm) { const brg = Math.round(r() * 359); for (let j = 0; j < 3; j++) out.push({ type: 'swarm', t: 30 + j * 0.8, brg: (brg + j * 3) % 360, dist: 900 + j * 20, alt: 40 + j * 5, goal: 'hunt', gi: 0 }); }
  // Not to be engaged: a civil drone over the town, a bird, a friendly helicopter or aircraft.
  if (T.civil) out.push({ type: 'civil', t: 14 + r() * 10, brg: Math.round(r() * 359), dist: 600, alt: 45 + r() * 30, goal: 'wander', gi: 0 });
  if (T.bird) out.push({ type: 'bird', t: 20 + r() * 20, brg: Math.round(r() * 359), dist: 450, alt: 30 + r() * 30, goal: 'wander', gi: 0 });
  if (T.friendly && d >= 2) out.push({ type: 'friendly', t: 40 + r() * 20, brg: Math.round(r() * 359), dist: 1600, alt: 160 + r() * 60, goal: 'wander', gi: 0 });
  return out.sort((a, b) => a.t - b.t);
}

export function createPatrol(cfg: PatrolCfg, W: PatrolWorld, C: Config = getConfig()): PatrolEngine {
  const G = gunsOf(C), gun = G.guns.zsu234;
  if (!gun) throw new Error('The urban patrol drill needs the ZSU-23-4 in guns.json');
  const r = mulberry(cfg.seed * 29 + 77), { route, cps } = buildRoute(W, r, cfg.checkpoints ?? 3);
  const s = route[0], n = route[1] ?? [s[0], s[1] + 1], issue = cfg.issueRounds ?? 3000, ready = Math.min(issue, gun.beltRounds * gun.barrels);
  const cars: PCar[] = [];
  for (let i = 0; i < Math.min(W.lanes.length * 2, 2 + cfg.difficulty); i++) cars.push({ lane: i % Math.max(1, W.lanes.length), speed: 5 + r() * 5, s: r() * 600, len: 4.6, waiting: false });
  const E: PatrolEngine = {
    C, G, gun, am: G.ammo[gun.ammo], cfg, W, tick: 0, dt: C.training.sim.dt,
    veh: { x: s[0], y: s[1], hdg: (Math.atan2(n[0] - s[0], n[1] - s[1]) * 180) / Math.PI, v: 0, thr: 0, str: 0, odo: 0, contact: false, hits: 0 },
    g: { az: 0, el: 8, rAz: 0, rEl: 0, trig: false, ready, reserve: issue - ready, busyUntil: null, heat: 0, acc: 0, fired: 0, lockCid: null, lockStart: null, lockBlocked: 0 },
    route, cps, cpDone: [], wp: Math.min(1, route.length - 1), spawns: [], next: 0, targets: [], cars: W.lanes.length ? cars : [], rounds: [], bursts: [], pending: [], ev: [], fcs: null,
    seen: {}, spots: {}, idents: [], collisions: [], grid: buildGrid(W),
  };
  E.g.az = E.veh.hdg;
  // Start clear of parked cars and poles: nudge along the route if the first pose is blocked.
  // Cars that start on top of the patrol move on along their lane first.
  for (const c of E.cars) for (let k = 0; k < 40 && Math.hypot(carPose(E, c).x - E.veh.x, carPose(E, c).y - E.veh.y) < 15; k++) c.s += 3;
  for (let k = 0; k < 30 && hullBlocked(E, E.veh.x, E.veh.y, E.veh.hdg); k++) { const a = (E.veh.hdg * Math.PI) / 180; E.veh.x += Math.sin(a) * 2; E.veh.y += Math.cos(a) * 2; }
  E.spawns = buildPatrolScenario(cfg, W, C);
  return E;
}

const tgt = (E: PatrolEngine, id: number | null | undefined) => (id == null ? undefined : E.targets.find((t) => t.id === id));
const live = (E: PatrolEngine) => E.targets.filter((t) => t.state === 'live');

function spawn(E: PatrolEngine, sp: PSpawn): void {
  const ty = E.C.threats.threats[sp.type], a = (sp.brg * Math.PI) / 180, c = E.W.centre;
  const p: Vec3 = [c[0] + Math.sin(a) * sp.dist, c[1] + Math.cos(a) * sp.dist, sp.alt];
  const L = E.W.landmarks[sp.gi % Math.max(1, E.W.landmarks.length)];
  const g = sp.goal === 'asset' && L ? [L.x, L.y, 4] : sp.goal === 'wander' ? [c[0] - Math.sin(a) * sp.dist, c[1] - Math.cos(a) * sp.dist, sp.alt] : [c[0], c[1], sp.alt];
  const d = Math.hypot(g[0] - p[0], g[1] - p[1]) || 1;
  E.targets.push({ id: E.targets.length + 1, type: sp.type, hostile: ty.hostile, spawnTick: E.tick, p, prev: [...p] as Vec3, v: [((g[0] - p[0]) / d) * ty.speed, ((g[1] - p[1]) / d) * ty.speed, 0],
    goal: sp.goal, gx: g[0], gy: g[1], gz: g[2], orbitR: sp.goal === 'orbit' ? 260 + (sp.brg % 7) * 40 : 0, orbitSec: 0, state: 'live', hits: 0, endTick: null });
  E.ev.push({ tick: E.tick, k: 'spawn', cid: E.targets.length });
}

/** Move a drone one tick: turn-rate-limited flight towards its goal, a dive in the last few hundred metres. */
function moveTarget(E: PatrolEngine, T: PTarget, t: number): void {
  const ty = E.C.threats.threats[T.type], dt = E.dt, sp = ty.speed;
  T.prev = [...T.p] as Vec3;
  let gx = T.gx, gy = T.gy, gz = T.gz;
  if (T.goal === 'hunt') { gx = E.veh.x; gy = E.veh.y; gz = 2; }
  const dx = gx - T.p[0], dy = gy - T.p[1], hd = Math.hypot(dx, dy);
  let want = Math.atan2(dx, dy);
  if (T.goal === 'orbit' && hd < T.orbitR + 40) { want = Math.atan2(dx, dy) + Math.PI / 2 * (T.id % 2 ? 1 : -1) * clamp((T.orbitR + 40 - hd) / 60 + 0.6, 0.6, 1); T.orbitSec += dt; }
  if (ty.motion === 'weave' || ty.motion === 'swarm') want += 0.35 * Math.sin(t * 0.9 + T.id);
  if (T.goal === 'wander') want += 0.25 * Math.sin(t * 0.3 + T.id * 2);
  const cur = Math.atan2(T.v[0], T.v[1]), turn = (90 * Math.PI) / 180 * dt;
  let da = want - cur; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
  const h = cur + clamp(da, -turn, turn);
  // Height: cruise above the rooftops, then dive onto the goal: steeply over the last 70 m (FPV hunters, which need to
  // see the patrol) or over the last 250 m (strike drones).
  const D = T.goal === 'hunt' ? 70 : 250, diving = (T.goal === 'hunt' || T.goal === 'asset') && hd < D;
  const wantZ = diving ? gz + (T.p[2] - gz) * clamp(hd / D, 0, 1) * 0.9 : T.goal === 'orbit' ? T.gz : T.p[2];
  const vz = clamp((wantZ - T.p[2]) / Math.max(dt, 0.5), -sp * 0.6, sp * 0.4);
  const hs = Math.sqrt(Math.max(0, sp * sp - vz * vz));
  T.v = [Math.sin(h) * hs, Math.cos(h) * hs, vz];
  T.p = [T.p[0] + T.v[0] * dt, T.p[1] + T.v[1] * dt, Math.max(1, T.p[2] + vz * dt)];
}

function apply(E: PatrolEngine, a: PatrolAction): void {
  const g = E.g;
  switch (a.k) {
    case 'drive': E.veh.thr = clamp(a.thr ?? 0, -1, 1); E.veh.str = clamp(a.str ?? 0, -1, 1); return;
    case 'slew': g.rAz = clamp(a.az ?? 0, -1, 1); g.rEl = clamp(a.el ?? 0, -1, 1); return;
    case 'trig': g.trig = !!a.on; return;
    case 'lock': {
      const T = tgt(E, a.cid);
      if (a.cid == null) { if (g.lockCid != null) E.ev.push({ tick: E.tick, k: 'unlock', cid: g.lockCid }); g.lockCid = null; g.lockStart = null; return; }
      if (!T || T.state !== 'live' || !pVisible(E, T) || losOf(rel(T.p, gunOrigin(E))).range > (fcsOf(E.gun)?.acquireRangeM ?? 0)) { E.ev.push({ tick: E.tick, k: 'lockFail', cid: a.cid }); return; }
      g.lockCid = T.id; g.lockStart = E.tick; g.lockBlocked = 0; E.ev.push({ tick: E.tick, k: 'lock', cid: T.id }); return;
    }
    case 'spot': { const T = tgt(E, a.cid); if (T && T.state === 'live' && E.spots[T.id] == null) { E.spots[T.id] = E.tick; E.ev.push({ tick: E.tick, k: 'spot', cid: T.id }); } return; }
    case 'ident': {
      const T = tgt(E, a.cid);
      if (!T || T.state !== 'live' || !a.cls || (a.cls !== 'unknown' && !E.C.threats.threats[a.cls])) return;
      if (E.spots[T.id] == null) { E.spots[T.id] = E.tick; E.ev.push({ tick: E.tick, k: 'spot', cid: T.id }); }
      E.idents.push({ tick: E.tick, cid: T.id, cls: a.cls }); E.ev.push({ tick: E.tick, k: 'ident', cid: T.id, text: a.cls }); return;
    }
    case 'load': {
      if (g.busyUntil != null || g.reserve <= 0 || g.ready >= E.gun.beltRounds * E.gun.barrels) return;
      g.busyUntil = E.tick + sec(E, E.gun.reload?.reduce((s, x) => s + x.sec, 0) ?? E.G.procedure.loadSec); g.trig = false; E.ev.push({ tick: E.tick, k: 'loading' }); return;
    }
  }
}

/** The live, visible target nearest the barrel line (deg), within maxDeg. */
export function pOnLine(E: PatrolEngine, maxDeg: number): PTarget | undefined {
  let best: PTarget | undefined, bd = maxDeg;
  const o = gunOrigin(E);
  for (const T of live(E)) {
    const L = losOf(rel(T.p, o)), d = Math.hypot(angDiff(L.az, E.g.az) * Math.cos((L.el * Math.PI) / 180), L.el - E.g.el);
    if (d < bd) { bd = d; best = T; }
  }
  return best;
}
/** Is the radar locked and tracking (lock time elapsed)? */
export const pLocked = (E: PatrolEngine): boolean => E.g.lockCid != null && E.g.lockStart != null && E.tick - E.g.lockStart >= sec(E, fcsOf(E.gun)?.lockSec ?? 0);

function fire(E: PatrolEngine): void {
  const g = E.g, gun = E.gun, am = E.am, o = gunOrigin(E);
  g.acc += ((gun.barrels * gun.rpmPerBarrel) / 60) * E.dt;
  let burst = E.bursts[E.bursts.length - 1];
  if (!burst || burst.end != null) {
    const on = pOnLine(E, 6);
    burst = { start: E.tick, end: null, rounds: 0, cid: on?.id ?? null, ok: pCleared(E, on?.id ?? null), nonHostile: !!on && !on.hostile };
    E.bursts.push(burst); E.ev.push({ tick: E.tick, k: burst.ok ? 'burst' : 'unclearedBurst', cid: on?.id });
  }
  // Firing on the move opens the pattern (training value).
  const disp = gun.dispMil * (180 / Math.PI / 1000) * (g.heat > gun.heatLimit ? 2 : 1) * (1 + (VEH.moveDisp * Math.abs(E.veh.v)) / VEH.vMax);
  const mv0 = muzzleVelocity(am, E.cfg.met.tempC, E.G.met.stdTempC);
  while (g.acc >= 1 && g.ready > 0) {
    g.acc -= 1;
    const i = g.fired++;
    g.ready--; g.heat += gun.heatPerRound;
    const az = g.az + gauss(E.cfg.seed * 3 + 1, i) * disp / Math.max(0.2, Math.cos((g.el * Math.PI) / 180)), el = g.el + gauss(E.cfg.seed * 3 + 2, i) * disp;
    const mv = mv0 + gauss(E.cfg.seed * 3 + 5, i) * am.mvSd;
    // Where the round meets the first building or wall (if it does, before it climbs clear of the rooftops).
    let bt: number | null = null, bp: Vec3 | null = null, prev: Vec3 = o;
    fly(am, { az, el, mv }, E.cfg.met, { dt: 0.05, tMax: 4 }, (tt, p, v) => {
      const w: Vec3 = [o[0] + p[0], o[1] + p[1], o[2] + p[2]];
      if (w[2] < 0) { bt = tt; bp = [w[0], w[1], 0]; return true; }
      const f = segBlocked(E, prev, w);
      if (f != null) { bt = tt - 0.05 * (1 - f); bp = [prev[0] + (w[0] - prev[0]) * f, prev[1] + (w[1] - prev[1]) * f, prev[2] + (w[2] - prev[2]) * f]; return true; }
      prev = w;
      return (w[2] > E.grid.maxTop + 2 && v[2] > 0) || Math.abs(w[0] - E.W.centre[0]) > E.W.half + 80 || Math.abs(w[1] - E.W.centre[1]) > E.W.half + 80;
    });
    let best: { cid: number; miss: number; tau: number } | null = null;
    for (const T of live(E)) {
      const r0 = rel(T.p, o), L = losOf(r0);
      if (Math.hypot(angDiff(L.az, az), L.el - el) > 10 || L.range > HORIZON_M) continue;
      const ap = closestApproach(am, { az, el, mv }, E.cfg.met, (tau) => [r0[0] + T.v[0] * tau, r0[1] + T.v[1] * tau, r0[2] + T.v[2] * tau], am.selfDestructSec > 0 ? am.selfDestructSec : 8, 0.01);
      if (!best || ap.miss < best.miss) best = { cid: T.id, miss: ap.miss, tau: ap.tau };
    }
    const T = best && tgt(E, best.cid), sz = T ? E.C.threats.threats[T.type].echo : '';
    const blocked = bt != null && best != null && best.tau > bt;
    const hit = !!(best && T && !blocked && best.miss <= Math.max(E.G.targets.hitRadiusM[sz] ?? 0.4, am.proxM ?? 0));
    E.rounds.push({ i, tick: E.tick, o, az, el, mv, cid: best?.cid ?? null, miss: best?.miss ?? Infinity, tau: best?.tau ?? 0, hit, bt: hit ? null : bt, bp: hit ? null : bp });
    if (hit && best) E.pending.push({ tick: E.tick + Math.max(1, Math.ceil(best.tau / E.dt)), cid: best.cid });
    burst.rounds++;
  }
  if (g.ready <= 0) { g.trig = false; E.ev.push({ tick: E.tick, k: 'empty' }); }
}

/** Advance one tick: actions, spawns, the vehicle, the turret, firing, the drones. */
export function stepPatrol(E: PatrolEngine, acts: PatrolAction[]): void {
  for (const a of acts) apply(E, a);
  const g = E.g, gun = E.gun, V = E.veh, dt = E.dt, t = E.tick * dt;
  while (E.next < E.spawns.length && E.spawns[E.next].t <= t) spawn(E, E.spawns[E.next++]);
  if (g.busyUntil != null && E.tick >= g.busyUntil) { const n = Math.min(g.reserve, gun.beltRounds * gun.barrels - g.ready); g.reserve -= n; g.ready += n; g.busyUntil = null; E.ev.push({ tick: E.tick, k: 'loaded' }); }
  // Vehicle: tracked, skid steer; speed follows the throttle within acceleration limits; four sub-steps against obstacles.
  const want = V.thr >= 0 ? V.thr * VEH.vMax : V.thr * VEH.vRev, dv = want - V.v, lim = (Math.sign(dv) === Math.sign(V.v) || V.v === 0 ? VEH.acc : VEH.brake) * dt;
  V.v += clamp(dv, -lim, lim);
  const turn = V.str * (VEH.turnDegS - (VEH.turnDegS - VEH.turnHiDegS) * Math.min(1, Math.abs(V.v) / VEH.vMax));
  let touched: 'building' | 'car' | null = null;
  for (let s = 0; s < 4; s++) {
    const h = V.hdg + (turn * dt) / 4, a = (h * Math.PI) / 180, nx = V.x + Math.sin(a) * V.v * dt / 4, ny = V.y + Math.cos(a) * V.v * dt / 4;
    const b = hullBlocked(E, nx, ny, h);
    if (!b) { V.odo += Math.abs(V.v) * dt / 4; V.x = nx; V.y = ny; V.hdg = (h + 360) % 360; continue; }
    touched = b;
    // Slide along an obstacle where we can (keep the heading change only if the hull fits).
    if (!hullBlocked(E, nx, V.y, V.hdg)) V.x = nx; else if (!hullBlocked(E, V.x, ny, V.hdg)) V.y = ny;
    if (!hullBlocked(E, V.x, V.y, h)) V.hdg = (h + 360) % 360;
  }
  if (touched && !V.contact) { E.collisions.push({ tick: E.tick, kind: touched, speed: Math.abs(V.v) }); E.ev.push({ tick: E.tick, k: touched === 'car' ? 'carHit' : 'collision', n: Math.round(Math.abs(V.v) * 3.6) }); }
  if (touched) V.v *= touched === 'car' ? 0 : 0.5;
  V.contact = !!touched;
  // Civilian traffic: each car drives on unless the patrol is in its way (then it waits).
  for (const c of E.cars) {
    const p = carPose(E, c), ahead = carPose(E, c, c.s + 7);
    c.waiting = Math.hypot(ahead.x - V.x, ahead.y - V.y) < 7 || Math.hypot(p.x - V.x, p.y - V.y) < 5;
    if (!c.waiting) c.s += c.speed * dt;
  }
  // Route progress and checkpoints.
  if (E.wp < E.route.length - 1 && Math.hypot(E.route[E.wp][0] - V.x, E.route[E.wp][1] - V.y) < 12) E.wp++;
  for (const k of E.cps) if (!E.cpDone.includes(k) && Math.hypot(E.route[k][0] - V.x, E.route[k][1] - V.y) < 14) { E.cpDone.push(k); E.ev.push({ tick: E.tick, k: 'checkpoint', n: E.cpDone.length }); }
  // Turret (stabilised: holds its bearing while the hull turns): radar laying on a lock, or the handwheels.
  const sAz = gun.slewDegS.az * dt, sEl = gun.slewDegS.el * dt;
  if (g.lockCid != null) {
    const T = tgt(E, g.lockCid);
    if (!T || T.state !== 'live') { g.lockCid = null; g.lockStart = null; E.fcs = null; }
    else {
      g.lockBlocked = pClear(E, T) ? 0 : g.lockBlocked + dt;
      if (g.lockBlocked > 1) { E.ev.push({ tick: E.tick, k: 'lockLost', cid: T.id }); g.lockCid = null; g.lockStart = null; E.fcs = null; }
    }
  }
  if (pLocked(E)) {
    const T = tgt(E, g.lockCid)!, o = gunOrigin(E), n = (fcsOf(gun)?.trackNoiseMil ?? 0) * (180 / Math.PI / 1000) * (Math.PI / 180), r0 = rel(T.p, o), R = Math.hypot(...r0);
    const np: Vec3 = [r0[0] + gauss(E.cfg.seed + 11, E.tick) * n * R, r0[1] + gauss(E.cfg.seed + 12, E.tick) * n * R, r0[2] + gauss(E.cfg.seed + 13, E.tick) * n * R];
    E.fcs = solveAim(E.am, muzzleVelocity(E.am, E.cfg.met.tempC, E.G.met.stdTempC), E.cfg.met, np, T.v, E.fcs);
    if (E.fcs.ok) { g.az = (g.az + clamp(angDiff(E.fcs.az, g.az), -sAz, sAz) + 360) % 360; g.el += clamp(E.fcs.el - g.el, -sEl, sEl); }
  } else { E.fcs = null; g.az = (g.az + g.rAz * sAz + 360) % 360; g.el += g.rEl * sEl; }
  g.el = clamp(g.el, gun.elevDeg[0], gun.elevDeg[1]);
  g.heat = Math.max(0, g.heat - gun.coolPerSec * dt);
  if (g.trig && g.ready > 0 && g.busyUntil == null) fire(E);
  else { const b = E.bursts[E.bursts.length - 1]; if (b && b.end == null) b.end = E.tick; g.acc = 0; }
  // Hits land.
  for (const h of E.pending) if (h.tick === E.tick) {
    const T = tgt(E, h.cid);
    if (T && T.state === 'live' && ++T.hits >= (E.G.targets.hitsToKill[E.C.threats.threats[T.type].echo] ?? 1)) { T.state = 'destroyed'; T.endTick = E.tick; E.ev.push({ tick: E.tick, k: 'destroyed', cid: T.id }); }
  }
  // Drones fly; attackers strike the patrol or the defended place; watchers that stay overhead long enough have fixed us.
  for (const T of live(E)) {
    moveTarget(E, T, t);
    const hv = Math.hypot(T.p[0] - V.x, T.p[1] - V.y), ha = Math.hypot(T.p[0] - T.gx, T.p[1] - T.gy);
    const end = (kind: 'vehicle' | 'asset' | 'observed') => { T.state = 'leaked'; T.endTick = E.tick; T.leakKind = kind; E.ev.push({ tick: E.tick, k: kind === 'vehicle' ? 'vehicleHit' : kind === 'asset' ? 'assetHit' : 'observed', cid: T.id }); if (kind === 'vehicle') V.hits++; };
    if (T.hostile && T.goal === 'hunt' && hv < 6 && T.p[2] < 6) end('vehicle');
    else if (T.hostile && T.goal === 'asset' && ha < 15 && T.p[2] < 12) end('asset');
    else if (T.hostile && T.goal === 'orbit' && T.orbitSec > 45) end('observed');
    else if (Math.hypot(T.p[0] - E.W.centre[0], T.p[1] - E.W.centre[1]) > 2600) { T.state = 'gone'; T.endTick = E.tick; }
    else if (T.goal === 'wander' && ha < 40) { T.state = 'gone'; T.endTick = E.tick; }
  }
  for (const T of live(E)) if (E.seen[T.id] == null && pVisible(E, T)) E.seen[T.id] = E.tick;
  E.tick++;
}

export const patrolMaxTicks = (E: PatrolEngine): number => sec(E, E.cfg.maxSec ?? 240);
/** Over when the time is up, the vehicle is knocked out (two strikes), or every hostile is resolved and the route driven. */
export function patrolDone(E: PatrolEngine): boolean {
  if (E.tick >= patrolMaxTicks(E) || E.veh.hits >= 2) return true;
  const H = E.targets.filter((t) => t.hostile);
  if (E.spawns.slice(E.next).some((s) => E.C.threats.threats[s.type]?.hostile) || !H.length || H.some((t) => t.state === 'live')) return false;
  return E.cpDone.length >= E.cps.length && E.tick >= Math.max(...H.map((t) => t.endTick ?? 0)) + sec(E, 3);
}
export function runPatrol(cfg: PatrolCfg, W: PatrolWorld, o: { actions?: PatrolAction[]; policy?: (E: PatrolEngine) => PatrolAction[]; stopWhenDone?: boolean } = {}, C: Config = getConfig()): PatrolEngine {
  const E = createPatrol(cfg, W, C), by = new Map<number, PatrolAction[]>();
  for (const a of o.actions ?? []) (by.get(a.tick) ?? by.set(a.tick, []).get(a.tick)!).push(a);
  while (E.tick < patrolMaxTicks(E)) {
    stepPatrol(E, (by.get(E.tick) ?? []).concat((o.policy?.(E) ?? []).map((a) => ({ ...a, tick: E.tick }))));
    if ((o.stopWhenDone ?? true) && patrolDone(E)) break;
  }
  return E;
}

// ---------- expert commander (tests and the demo): drives the route, reports, identifies, locks and fires ----------
export function patrolAI(E: PatrolEngine): PatrolAction[] {
  const out: PatrolAction[] = [], V = E.veh, t = E.tick, k = (a: Omit<PatrolAction, 'tick'>) => out.push({ ...a, tick: t });
  // Drive: follow the route to its last checkpoint, slow while engaging (the turret is stabilised), stop for traffic.
  let thr = 0, str = 0;
  if (E.cpDone.length < E.cps.length) {
    const p = E.route[E.wp], want = (Math.atan2(p[0] - V.x, p[1] - V.y) * 180) / Math.PI;
    // Look ahead along a few headings and take the one nearest the route that is clear (lamp posts, parked cars).
    const clear = (off: number) => [4, 8].every((ah) => { const b = ((want + off) * Math.PI) / 180; return hullBlocked(E, V.x + Math.sin(b) * ah, V.y + Math.cos(b) * ah, want + off) == null; });
    const off = [0, 12, -12, 25, -25, 40, -40].find(clear) ?? 0, d = angDiff(want + off, V.hdg);
    str = clamp(d / 20, -1, 1); thr = Math.abs(d) > 30 ? 0 : clamp(Math.hypot(p[0] - V.x, p[1] - V.y) / 25, 0.3, E.g.lockCid != null ? 0.35 : 0.7);
    const a = (V.hdg * Math.PI) / 180;
    for (const ah of [5, 9]) if (hullBlocked(E, V.x + Math.sin(a) * ah, V.y + Math.cos(a) * ah, V.hdg) === 'car') thr = 0;
    // Stuck against something: back off for a second and a half, turning towards the route.
    const lc = E.collisions[E.collisions.length - 1];
    if (lc && lc.kind === 'building' && t - lc.tick < Math.round(1.5 / E.dt)) { thr = -0.6; str = -clamp(d / 20, -1, 1); }
  }
  if (Math.abs(thr - V.thr) > 0.04 || Math.abs(str - V.str) > 0.04) k({ k: 'drive', thr: Math.round(thr * 50) / 50, str: Math.round(str * 50) / 50 });
  // Report and identify what can be seen (after a realistic second and a half), most urgent first.
  for (const T of E.targets) {
    if (T.state !== 'live' || E.seen[T.id] == null) continue;
    if (E.spots[T.id] == null && t - E.seen[T.id] >= Math.round(1.5 / E.dt)) k({ k: 'spot', cid: T.id });
    if (E.spots[T.id] != null && pIdentOf(E, T.id) == null && t - E.spots[T.id] >= Math.round(1.5 / E.dt)) k({ k: 'ident', cid: T.id, cls: T.type });
  }
  // Engage: lock the nearest cleared hostile in sight, fire when the solution is good and it is in range.
  const o = gunOrigin(E), cleared = E.targets.filter((T) => T.state === 'live' && pCleared(E, T.id) && pVisible(E, T));
  const range = (T: PTarget) => losOf(rel(T.p, o)).range;
  const best = cleared.sort((a, b) => range(a) - range(b))[0];
  if (best && E.g.lockCid !== best.id && range(best) < (fcsOf(E.gun)?.acquireRangeM ?? 3000)) k({ k: 'lock', cid: best.id });
  const L = E.g.lockCid != null ? tgt(E, E.g.lockCid) : undefined;
  const on = !!(L && pLocked(E) && E.fcs?.ok && range(L) < Math.min(E.gun.effRangeM, E.G.targets.engageRangeM?.[E.C.threats.threats[L.type].echo] ?? E.gun.effRangeM)
    && Math.abs(angDiff(E.fcs.az, E.g.az)) < 0.6 && Math.abs(E.fcs.el - E.g.el) < 0.6 && E.fcs.el > 1 && segBlocked(E, o, L.p) == null);
  if (on !== E.g.trig) k({ k: 'trig', on });
  if (E.g.ready === 0 && E.g.busyUntil == null && E.g.reserve > 0) k({ k: 'load' });
  return out;
}

// ---------- scoring (rules P1–P9) ----------
export const PATROL_RULES: Record<string, string> = {
  P1: 'Detect: report each contact within 4 s of it coming into sight (30 points, none after 20 s).',
  P2: 'Identify: the right type (30), the right side but wrong type (15), Unknown (10).',
  P3: 'Defeat: destroy each hostile before it strikes (40); a non-hostile left alone (40).',
  P4: 'Never engage a civil drone, a friendly aircraft or a bird.',
  P5: 'Collateral: rounds into buildings in a built-up area (−1 per 25 rounds, at most −15).',
  P6: 'Weapon Control Status: fire only on contacts identified hostile (−5 per burst, at most −20).',
  P7: 'Driving: collisions with buildings above walking pace (−2) and civilian vehicles (−10), at most −20.',
  P8: 'The patrol was struck by a drone (−15 each).',
  P9: 'Patrol route: every checkpoint reached (−5 each missed).',
};
export interface PatrolScore {
  game: 'patrol'; total: number; parts: GunPart[]; deductions: GunPart[]; why: string[]; rules: string[];
  metrics: { roundsFired: number; hits: number; kills: number; hostiles: number; leaked: number; buildingRounds: number; collisions: number; carHits: number; checkpoints: string; distanceM: number; vehicleHits: number };
}
export function scorePatrol(E: PatrolEngine): PatrolScore {
  const T = E.C.threats.threats, D = detectOf(E.G), why: string[] = [], rules = new Set<string>();
  let det = 0, idp = 0, def = 0, n = 0;
  for (const tg of E.targets) {
    const name = `Contact ${tg.id} (${T[tg.type].short})`, seen = E.seen[tg.id];
    if (seen == null && !tg.hostile) continue; // never in sight: nothing to report
    n++;
    // P1
    const sp = E.spots[tg.id];
    if (seen == null) { why.push(`P1 ${name}: never in sight from where you were; move to get eyes on.`); rules.add('P1'); }
    else if (sp == null) { why.push(`P1 ${name}: never reported.`); rules.add('P1'); }
    else { const s = Math.max(0, (sp - seen) * E.dt), p = s <= D.spotWithinSec ? 30 : Math.max(0, 30 * (1 - (s - D.spotWithinSec) / (20 - D.spotWithinSec))); det += p; if (p < 30) { why.push(`P1 ${name}: reported ${s.toFixed(1)} s after it came into sight.`); rules.add('P1'); } }
    // P2
    const c = pIdentOf(E, tg.id);
    const ip = c == null ? 0 : c === 'unknown' ? 10 : c === tg.type ? 30 : !!T[c]?.hostile === tg.hostile ? 15 : 0;
    idp += ip; if (ip < 30) { why.push(`P2 ${name}: ${c == null ? 'not identified' : c === 'unknown' ? 'left as Unknown' : `identified as ${T[c]?.short ?? c}`}.`); rules.add('P2'); }
    // P3 / P4
    if (tg.hostile) {
      const p = tg.state === 'destroyed' ? 40 : tg.state === 'leaked' ? 0 : 10;
      def += p; if (p < 40) { why.push(`P3 ${name}: ${tg.state === 'leaked' ? (tg.leakKind === 'vehicle' ? 'struck the patrol' : tg.leakKind === 'asset' ? 'struck the defended place' : 'stayed overhead long enough to fix the patrol') : 'not defeated'}.`); rules.add('P3'); }
    } else {
      const fired = E.bursts.some((b) => b.cid === tg.id) || E.rounds.some((r) => r.cid === tg.id && r.miss < 15);
      def += fired ? 0 : 40; if (fired) { why.push(`P4 ${name}: engaged a ${tg.type === 'bird' ? 'bird' : T[tg.type].friendly ? 'friendly aircraft' : 'civil drone'}.`); rules.add('P4'); }
    }
  }
  const base = n ? (det + idp + def) / n : 0;
  const parts: GunPart[] = [
    { rule: 'P1', label: 'Detect', pts: Math.round(n ? det / n : 0), max: 30, why: [] },
    { rule: 'P2', label: 'Identify', pts: Math.round(n ? idp / n : 0), max: 30, why: [] },
    { rule: 'P3', label: 'Defeat', pts: Math.round(n ? def / n : 0), max: 40, why: [] },
  ];
  const ded: GunPart[] = [];
  const add = (rule: string, label: string, pts: number, w: string) => { if (pts < 0) { ded.push({ rule, label, pts, max: 0, why: [w] }); why.push(`${rule} ${w}`); rules.add(rule); } };
  const bRounds = E.rounds.filter((r) => r.bt != null && r.bp && r.bp[2] > 0.5).length;
  add('P5', 'Collateral', -Math.min(15, Math.floor(bRounds / 25)), `${bRounds} rounds struck buildings or walls.`);
  const unc = E.bursts.filter((b) => !b.ok).length;
  add('P6', 'Weapon Control Status', -Math.min(20, unc * 5), `${unc} burst${unc === 1 ? '' : 's'} at contacts not identified hostile.`);
  const bump = E.collisions.filter((c) => c.kind === 'building' && c.speed > 2).length, cars = E.collisions.filter((c) => c.kind === 'car').length;
  add('P7', 'Driving', -Math.min(20, bump * 2 + cars * 10), `${bump} collision${bump === 1 ? '' : 's'} with buildings, ${cars} with civilian vehicles.`);
  add('P8', 'Patrol struck', -15 * E.veh.hits, `the patrol was struck ${E.veh.hits} time${E.veh.hits === 1 ? '' : 's'}.`);
  const miss = E.cps.length - E.cpDone.length;
  add('P9', 'Patrol route', -5 * miss, `${miss} checkpoint${miss === 1 ? '' : 's'} not reached.`);
  const total = clamp(Math.round(base + ded.reduce((s, d) => s + d.pts, 0)), 0, 100);
  const H = E.targets.filter((t) => t.hostile);
  return { game: 'patrol', total, parts, deductions: ded, why, rules: [...rules],
    metrics: { roundsFired: E.rounds.length, hits: E.rounds.filter((r) => r.hit).length, kills: H.filter((t) => t.state === 'destroyed').length, hostiles: H.length, leaked: H.filter((t) => t.state === 'leaked').length,
      buildingRounds: bRounds, collisions: bump, carHits: cars, checkpoints: `${E.cpDone.length}/${E.cps.length}`, distanceM: Math.round(E.veh.odo), vehicleHits: E.veh.hits } };
}
