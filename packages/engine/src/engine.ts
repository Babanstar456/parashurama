import { getConfig, ticks, isEffective, weatherFx, type Config } from './config';
import { buildScenario } from './scenario';
import type { Action, Contact, DrillConfig, Engine, Spawn } from './types';
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

function moveContact(E: Engine, c: Contact, swarm: Contact[]): void {
  const dt = E.C.training.sim.dt, t = E.tick * dt, Ty = E.C.threats.threats[c.type], R = E.C.training.sim.radarRangeM;
  if (Ty.motion === 'wander') {
    c.hdg += Math.sin(t * 0.7 + c.wob) * 0.6 * dt; c.x += Math.sin(c.hdg) * c.v * dt; c.y -= Math.cos(c.hdg) * c.v * dt;
    if (Math.hypot(c.x, c.y) > R * 0.93) c.hdg += Math.PI * dt * 4;
    return;
  }
  if (Ty.motion === 'orbit') { c.oc += (c.v / c.orad) * dt; c.x = Math.sin(c.oc) * c.orad; c.y = -Math.cos(c.oc) * c.orad; c.hdg = c.oc + Math.PI / 2; return; }
  const d = Math.hypot(c.x, c.y);
  // Surveillance UAV: flies in, then circles the asset at standoff range to watch (hover = on station, so no time to impact).
  if (Ty.motion === 'surveil' && (c.orbit || d <= c.orad)) {
    if (!c.orbit) { c.orbit = true; c.hover = true; c.orad = d; c.oc = Math.atan2(c.x, -c.y); }
    c.oc += (c.v / c.orad) * dt; c.x = Math.sin(c.oc) * c.orad; c.y = -Math.cos(c.oc) * c.orad; c.hdg = c.oc + Math.PI / 2; return;
  }
  if (Ty.motion === 'approachHover' && d <= c.hoverR) {
    c.hover = true; c.x += Math.sin(t * 0.5 + c.wob) * 0.8 * dt; c.y += Math.cos(t * 0.4 + c.wob) * 0.6 * dt; return;
  }
  let dx = -c.x / d, dy = -c.y / d;
  if (Ty.motion === 'swarm') {
    let cx = 0, cy = 0, sx = 0, sy = 0, n = 0;
    for (const o of swarm) {
      if (o === c) continue;
      const ox = o.x - c.x, oy = o.y - c.y, od = Math.hypot(ox, oy) || 1;
      if (od < 500) { cx += ox; cy += oy; n++; if (od < 90) { sx -= ox / od; sy -= oy / od; } }
    }
    if (n) { dx += cx / n / 600 + sx * 0.6; dy += cy / n / 600 + sy * 0.6; }
  }
  if (Ty.motion === 'weave') { dx += Math.sin(t * 1.7 + c.wob) * 0.3; dy += Math.cos(t * 1.3 + c.wob) * 0.3; }
  const m = Math.hypot(dx, dy) || 1;
  c.x += (dx / m) * c.v * dt; c.y += (dy / m) * c.v * dt; c.hdg = Math.atan2(dx, -dy);
  if (Math.hypot(c.x, c.y) < E.C.training.sim.assetRadiusM) { c.state = 'leaked'; c.endTick = E.tick; }
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
    if (c.trackTick != null && c.idTick == null && a.cls && E.C.threats.threats[a.cls] && a.conf != null) { c.idTick = E.tick; c.idCls = a.cls; c.idConf = a.conf; }
    return;
  }
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
  c.engs.push({ tick: E.tick, eff: a.eff, effective: ok, range: rng, tti: tt, priorityMiss: pm, ...(ok && !hit ? { miss: true } : {}), ...(roeOn ? { cleared: isCleared(E, c, a.eff) } : {}) });
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
