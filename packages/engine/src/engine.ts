import { acousticRange, cameraRange, getConfig, ticks, isEffective, weatherFx, type Config } from './config';
import { buildScenario } from './scenario';
import { action, condition, selector, sequence, type BTNode } from './behaviour';
import { UNKNOWN, type Action, type Contact, type DrillConfig, type Engine, type Spawn } from './types';
import { clamp, hash2, mulberry, brgOf } from './util';

export function createEngine(cfg: DrillConfig, C: Config = getConfig(), spawns?: Spawn[]): Engine {
  const stock: Record<string, number> = {};
  for (const [k, e] of Object.entries(C.effectors.effectors)) if (e.stock != null) stock[k] = e.stock;
  return { C, cfg, tick: 0, spawns: spawns ?? buildScenario(cfg, C), next: 0, contacts: [], stock, nid: 1 };
}

function spawnContact(E: Engine, sp: Spawn, idx: number): void {
  const Ty = E.C.threats.threats[sp.type];
  const R = E.C.training.sim.radarRangeM;
  const r = mulberry(E.cfg.seed * 31 + idx * 7919 + 7);
  const a = (sp.brg * Math.PI) / 180;
  // (random draws kept in the original order so existing seeds reproduce the same drills)
  const dist = sp.dist != null ? Math.min(sp.dist, R * 0.98) : Ty.motion === 'wander' ? R * (0.35 + r() * 0.5) : R * 0.98;
  const c: Contact = {
    id: E.nid++, type: sp.type, x: Math.sin(a) * dist, y: -Math.cos(a) * dist,
    alt: Ty.alt[0] + r() * (Ty.alt[1] - Ty.alt[0]), v: Ty.speed * (0.88 + r() * 0.24), hdg: a + Math.PI, wob: r() * 6.28,
    state: 'live', born: E.tick, firstPaint: null, lastPaint: -999, trackTick: null, idTick: null, idCls: null, idConf: null,
    engs: [], effectAt: null, effectBy: null, endTick: null, brg0: sp.brg, hover: false, area: false, areaFrom: null,
    orbit: false, oc: 0, orad: 0, hoverR: 0,
  };
  if (Ty.motion === 'orbit') {
    const [o0, o1] = Ty.orbitRadiusM ?? [1300, 2100];
    c.orbit = true; c.oc = a; c.orad = o0 + r() * (o1 - o0);
    c.x = Math.sin(a) * c.orad; c.y = -Math.cos(a) * c.orad;
  } else if (Ty.motion === 'wander') c.hdg = r() * 6.28;
  else if (Ty.motion === 'approachHover') { const [h0, h1] = Ty.hoverRangeM ?? [800, 1100]; c.hoverR = h0 + r() * (h1 - h0); }
  else if (Ty.motion === 'surveil') { const [o0, o1] = Ty.orbitRadiusM ?? [1400, 1900]; c.orad = o0 + r() * (o1 - o0); }
  E.contacts.push(c);
}

/** Seconds until the contact reaches the asset; Infinity if it is not closing. */
export function tti(c: Contact, C: Config = getConfig()): number {
  const m = C.threats.threats[c.type].motion;
  if (c.state !== 'live' || m === 'orbit' || m === 'wander' || c.hover) return Infinity;
  return Math.max(0, (Math.hypot(c.x, c.y) - C.training.sim.assetRadiusM) / c.v);
}

// ---------- threat AI: one behaviour tree, ticked for every live drone at every step ----------
/** What the tree sees and changes for one drone on one tick. */
export interface ThreatCtx {
  E: Engine; c: Contact; swarm: Contact[]; motion: string; dt: number; t: number;
  /** Distance to the asset (m) and the steering direction being built this tick. */ d: number; dx: number; dy: number;
}
const isMotion = (m: string) => condition<ThreatCtx>(`motion is ${m}`, (x) => x.motion === m);
const orbitStep = (x: ThreatCtx) => { const c = x.c; c.oc += (c.v / c.orad) * x.dt; c.x = Math.sin(c.oc) * c.orad; c.y = -Math.cos(c.oc) * c.orad; c.hdg = c.oc + Math.PI / 2; };
/**
 * The threat behaviour tree. Each drone type has a motion profile in config/threats.json (wander, orbit, surveil,
 * approachHover, straight, weave, swarm); the tree picks, every tick, the first behaviour whose conditions hold.
 * Birds wander; friendly patrols orbit; surveillance UAVs fly in, then take station and circle at stand-off; recon
 * quadcopters stop and hover once close; everything else makes an attack run on the asset, flocking (boids-style
 * cohesion and separation) when part of a swarm and weaving when its type weaves.
 */
export const THREAT_TREE: BTNode<ThreatCtx> = selector<ThreatCtx>('threat behaviour',
  sequence('wander (bird / clutter)', isMotion('wander'), action('drift and turn back at the radar edge', (x) => {
    const c = x.c, R = x.E.C.training.sim.radarRangeM;
    c.hdg += Math.sin(x.t * 0.7 + c.wob) * 0.6 * x.dt; c.x += Math.sin(c.hdg) * c.v * x.dt; c.y -= Math.cos(c.hdg) * c.v * x.dt;
    if (Math.hypot(c.x, c.y) > R * 0.93) c.hdg += Math.PI * x.dt * 4;
  })),
  sequence('patrol orbit (friendly)', isMotion('orbit'), action('fly the orbit', orbitStep)),
  sequence('surveillance on station', isMotion('surveil'), condition('on station or at stand-off range', (x) => x.c.orbit || x.d <= x.c.orad),
    action('take station', (x) => { const c = x.c; if (!c.orbit) { c.orbit = true; c.hover = true; c.orad = x.d; c.oc = Math.atan2(c.x, -c.y); } }),
    action('circle the asset and watch', orbitStep)),
  sequence('hover at stand-off', isMotion('approachHover'), condition('inside hover range', (x) => x.d <= x.c.hoverR),
    action('hold position', (x) => { const c = x.c; c.hover = true; c.x += Math.sin(x.t * 0.5 + c.wob) * 0.8 * x.dt; c.y += Math.cos(x.t * 0.4 + c.wob) * 0.6 * x.dt; })),
  sequence('attack run',
    action('steer at the asset', (x) => { x.dx = -x.c.x / x.d; x.dy = -x.c.y / x.d; }),
    selector('swarm flocking', sequence('in a swarm', isMotion('swarm'), action('cohesion and separation', (x) => {
      const c = x.c; let cx = 0, cy = 0, sx = 0, sy = 0, n = 0;
      for (const o of x.swarm) {
        if (o === c) continue;
        const ox = o.x - c.x, oy = o.y - c.y, od = Math.hypot(ox, oy) || 1;
        if (od < 500) { cx += ox; cy += oy; n++; if (od < 90) { sx -= ox / od; sy -= oy / od; } }
      }
      if (n) { x.dx += cx / n / 600 + sx * 0.6; x.dy += cy / n / 600 + sy * 0.6; }
    })), action('alone', () => undefined)),
    selector('evasive weave', sequence('weaving type', isMotion('weave'), action('weave', (x) => { x.dx += Math.sin(x.t * 1.7 + x.c.wob) * 0.3; x.dy += Math.cos(x.t * 1.3 + x.c.wob) * 0.3; })),
      action('fly straight', () => undefined)),
    action('move', (x) => { const c = x.c, m = Math.hypot(x.dx, x.dy) || 1; c.x += (x.dx / m) * c.v * x.dt; c.y += (x.dy / m) * c.v * x.dt; c.hdg = Math.atan2(x.dx, -x.dy); }),
    action('reached the asset?', (x) => { if (Math.hypot(x.c.x, x.c.y) < x.E.C.training.sim.assetRadiusM) { x.c.state = 'leaked'; x.c.endTick = x.E.tick; } })),
);
// One context object reused for every drone (no allocation per drone per tick).
const ctx: ThreatCtx = { E: null as unknown as Engine, c: null as unknown as Contact, swarm: [], motion: '', dt: 0, t: 0, d: 0, dx: 0, dy: 0 };
function moveContact(E: Engine, c: Contact, swarm: Contact[]): void {
  const dt = E.C.training.sim.dt;
  ctx.E = E; ctx.c = c; ctx.swarm = swarm; ctx.motion = E.C.threats.threats[c.type].motion; ctx.dt = dt; ctx.t = E.tick * dt;
  ctx.d = Math.hypot(c.x, c.y); ctx.dx = 0; ctx.dy = 0;
  THREAT_TREE.tick(ctx);
}

function paintProb(E: Engine, c: Contact, b: number): number {
  const S = E.C.training.sim;
  const r = Math.hypot(c.x, c.y) / S.radarRangeM;
  const rcs = E.C.threats.echoRcs[E.C.threats.threats[c.type].echo];
  let p = clamp(1.15 - r * 0.9 + Math.log10(rcs * 100) * 0.25, 0.15, 0.98);
  if (E.cfg.fault === 'radar') {
    const dd = Math.abs(((b - E.cfg.faultSector + 540) % 360) - 180);
    if (dd < S.radarFaultHalfWidthDeg) p *= S.radarFaultFactor;
  }
  return p * weatherFx(E.C, E.cfg.weather).radar;
}

/** Does this effector need clearance under the drill's ROE? 'free' (or no profile) never does. */
export function needsClearance(E: Engine, eff: string): boolean {
  const roe = E.cfg.roe ?? 'free';
  if (roe === 'free') return false;
  return E.C.doctrine.roe?.[roe]?.needsClearance.includes(eff) ?? false;
}
/** Is the contact cleared for this effector right now? */
export function isCleared(E: Engine, c: Contact, eff: string): boolean {
  return !needsClearance(E, eff) || (c.clrAt != null && E.tick >= c.clrAt);
}

/** What the operator could rely on right now: RF detector up, a clear camera picture in range, radar healthy on this bearing. */
export function clueAvailability(E: Engine, c: Contact): { rf: boolean; cam: boolean; radarOk: boolean } {
  const S = E.C.training.sim, f = E.cfg.fault;
  const inCam = Math.hypot(c.x, c.y) < cameraRange(E.C, E.cfg.time, E.cfg.weather);
  const dd = Math.abs(((brgOf(c.x, c.y) - E.cfg.faultSector + 540) % 360) - 180);
  return { rf: f !== 'rf', cam: f !== 'eo' && inCam, radarOk: f !== 'radar' || dd >= S.radarFaultHalfWidthDeg };
}

/** Acoustic clue: what the acoustic sensor hears from this contact, and whether it is within hearing range now.
 *  Null when no acoustic sensor is fitted. Pure: it never changes the drill, so replays and scores are unaffected. */
export function acousticClue(E: Engine, c: Contact): { sig: string; rangeM: number; heard: boolean } | null {
  const r = acousticRange(E.C, c.type, E.cfg);
  if (r == null) return null;
  return { sig: E.C.threats.threats[c.type].acoustic!.sig, rangeM: r, heard: Math.hypot(c.x, c.y) < r };
}

export function inReach(c: Contact, eff: string, C: Config = getConfig()): boolean {
  const e = C.effectors.effectors[eff];
  const d = Math.hypot(c.x, c.y);
  return d <= e.range && d >= e.min;
}

function applyAction(E: Engine, a: Action): void {
  const c = E.contacts.find((x) => x.id === a.cid);
  if (!c) return;
  if (a.k === 'track') { if (c.trackTick == null && c.state === 'live') c.trackTick = E.tick; return; }
  if (a.k === 'id') {
    // "Unknown" is a legitimate first answer; an Unknown can later be identified as a real class.
    const real = !!a.cls && !!E.C.threats.threats[a.cls], unk = a.cls === UNKNOWN;
    if (c.trackTick != null && (c.idTick == null || (c.idCls === UNKNOWN && real)) && (real || unk) && a.conf != null && c.state === 'live') { c.idTick = E.tick; c.idCls = a.cls!; c.idConf = a.conf; c.idAvail = clueAvailability(E, c); }
    return;
  }
  if (a.k === 'bda') { if (E.cfg.killAssess && c.state === 'neutralised' && c.bdaTick == null) c.bdaTick = E.tick; return; }
  if (a.k === 'req') {
    // Request clearance to engage (ROE). Only after identification, once per contact.
    if (c.idTick != null && c.clrReq == null && c.state === 'live') {
      const roe = E.cfg.roe ?? 'free', prof = roe === 'free' ? undefined : E.C.doctrine.roe?.[roe];
      c.clrReq = E.tick; c.clrAt = E.tick + ticks(E.C, prof?.clearanceSec ?? 0);
    }
    return;
  }
  if (a.k !== 'eng' || c.idTick == null || c.state !== 'live' || !a.eff) return;
  const rng = Math.hypot(c.x, c.y), tt = tti(c, E.C);
  if (a.eff === 'hold') { if (!c.engs.length) c.engs.push({ tick: E.tick, eff: 'hold', effective: false, range: rng, tti: tt }); return; }
  const ef = E.C.effectors.effectors[a.eff];
  if (!ef || c.effectAt != null || !inReach(c, a.eff, E.C)) return;
  if (ef.stock != null) { if ((E.stock[a.eff] ?? 0) <= 0) return; E.stock[a.eff]--; }
  const Ty = E.C.threats.threats[c.type];
  const ok = isEffective(Ty, ef);
  const ratio = E.C.doctrine.defeat.modifiers.priorityRatio;
  const pm = Ty.hostile && E.contacts.some((o) => o !== c && o.state === 'live' && o.trackTick != null && E.C.threats.threats[o.type].hostile && o.effectAt == null && tti(o, E.C) < tt * ratio);
  // Probability of kill: seeded, so replays and the server re-run see the same misses. pk = 1 (default) never draws.
  const pk = ef.pk ?? 1;
  const hit = pk >= 1 || hash2(c.id * 131 + E.cfg.seed, E.tick) < pk;
  // Under a restrictive ROE, record whether this shot was cleared. The effect still happens; the penalty is in scoring (R12).
  const roeOn = (E.cfg.roe ?? 'free') !== 'free';
  c.engs.push({ tick: E.tick, eff: a.eff, effective: ok, range: rng, tti: tt, priorityMiss: pm, ...(ok && !hit ? { miss: true } : {}), ...(roeOn ? { cleared: isCleared(E, c, a.eff) } : {}), ...(E.cfg.safeArcs ? { brg: brgOf(c.x, c.y) } : {}) });
  if (ok && hit) {
    c.effectAt = E.tick + ticks(E.C, ef.delay); c.effectBy = a.eff;
    if (ef.areaRadiusM && Ty.motion === 'swarm') {
      for (const o of E.contacts) {
        if (o !== c && o.type === c.type && o.state === 'live' && o.effectAt == null && Math.hypot(o.x - c.x, o.y - c.y) < ef.areaRadiusM) {
          o.effectAt = c.effectAt; o.effectBy = a.eff; o.area = true; o.areaFrom = c.id;
        }
      }
    }
  }
}

/** Advance the world by one tick. Actions are applied first, so live play and replays match exactly. */
export function step(E: Engine, acts: Action[]): void {
  const S = E.C.training.sim;
  for (const a of acts) applyAction(E, a);
  const t = E.tick * S.dt;
  while (E.next < E.spawns.length && E.spawns[E.next].t <= t) { spawnContact(E, E.spawns[E.next], E.next); E.next++; }
  const swarm = E.contacts.filter((c) => E.C.threats.threats[c.type].motion === 'swarm' && c.state === 'live');
  for (const c of E.contacts) if (c.state === 'live') moveContact(E, c, swarm);
  for (const c of E.contacts) if (c.state === 'live' && c.effectAt != null && E.tick >= c.effectAt) { c.state = 'neutralised'; c.endTick = E.tick; }
  const prev = ((E.tick * S.dt) / S.sweepSec * 360) % 360, cur = (((E.tick + 1) * S.dt) / S.sweepSec * 360) % 360;
  const sweepN = Math.floor((E.tick * S.dt) / S.sweepSec);
  for (const c of E.contacts) {
    if (c.state !== 'live') continue;
    const b = brgOf(c.x, c.y);
    const crossed = prev <= cur ? b > prev && b <= cur : b > prev || b <= cur;
    if (crossed && hash2(c.id * 97 + E.cfg.seed, sweepN) < paintProb(E, c, b)) { c.lastPaint = E.tick; if (c.firstPaint == null) c.firstPaint = E.tick; }
  }
  E.tick++;
}

export function visibleBlip(E: Engine, c: Contact): boolean {
  return c.state === 'live' && (c.trackTick != null || E.tick - c.lastPaint < ticks(E.C, E.C.training.sim.sweepSec * 1.6));
}
export function isDone(E: Engine): boolean {
  return E.tick >= ticks(E.C, E.C.training.sim.maxDrillSec) ||
    (E.next >= E.spawns.length && E.contacts.every((c) => !E.C.threats.threats[c.type].hostile || c.state !== 'live'));
}

export interface RunOptions { actions?: Action[]; policy?: ((E: Engine) => Action[]) | null; until?: number; stopWhenDone?: boolean; spawns?: Spawn[]; }
/** Re-run a drill from its seed and a list of actions (and/or a policy). Pure and deterministic. */
export function runSim(cfg: DrillConfig, o: RunOptions = {}, C: Config = getConfig()): Engine {
  const E = createEngine(cfg, C, o.spawns);
  const until = o.until ?? ticks(C, C.training.sim.maxDrillSec);
  const by = new Map<number, Action[]>();
  for (const a of o.actions ?? []) { const l = by.get(a.tick) ?? []; l.push(a); by.set(a.tick, l); }
  while (E.tick < until) {
    const acts = (by.get(E.tick) ?? []).concat(o.policy ? o.policy(E) : []);
    step(E, acts);
    if (o.stopWhenDone && isDone(E)) break;
  }
  return E;
}
