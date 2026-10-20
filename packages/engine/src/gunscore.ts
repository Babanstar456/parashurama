import { angDiff, losOf } from './ballistics';
import { getConfig, type Config } from './config';
import { engageRange, inSafeArc, targetPos, targetVel, unexploded, type GunDrillConfig, type GunEngine, type GunTarget, type OrderKind } from './gun';
import { SELF_DEFENCE_SEC } from './gunai';
import { bkt, type Observations } from './learning';
import { clamp } from './util';

/**
 * Scoring for the two gun games. Every point is traceable to a rule id in doctrine.json (G* on the ground, F* in the
 * control room) and comes with a plain sentence in `why`. Deductions (firing without clearance, into a safe arc,
 * against Weapon Control Status) take points off; they do not end the drill.
 */
export type GunGame = 'ground' | 'control';
export interface GunPart { rule: string; label: string; pts: number; max: number; why: string[]; }
export interface GunScore {
  game: GunGame; total: number; parts: GunPart[]; deductions: GunPart[]; why: string[]; rules: string[];
  metrics: { roundsFired: number; hits: number; kills: number; hostiles: number; leaked: number; ammoPerKill: number | null; violations: number; killRatePct: number };
}

const S = (E: GunEngine, ticks: number) => ticks * E.dt;
const T_ = (E: GunEngine, s: number) => Math.round(s / E.dt);
const tgt = (E: GunEngine, id: number | null | undefined) => (id == null ? undefined : E.targets.find((t) => t.id === id));
const rangeAt = (E: GunEngine, T: GunTarget, tick: number) => losOf(targetPos(T, tick * E.dt, E.dt)).range;
/** Seconds to the asset at a past tick (Infinity if not closing). */
export function ttiAt(E: GunEngine, T: GunTarget, tick: number): number {
  if (!T.hostile) return Infinity;
  const t = tick * E.dt, p = targetPos(T, t, E.dt), v = targetVel(T, t, E.dt);
  const h = Math.hypot(p[0], p[1]), closing = -(p[0] * v[0] + p[1] * v[1]) / (h || 1);
  return closing > 0.5 ? Math.max(0, (h - E.C.training.sim.assetRadiusM) / closing) : Infinity;
}
/** Linear credit: 1 at or below `full`, 0 at or above `zero`. */
const lin = (x: number, full: number, zero: number) => clamp(1 - (x - full) / (zero - full), 0, 1);
const avgOr = (a: number[], d = 1) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : d);
const part = (rule: string, label: string, max: number, frac: number, why: string[]): GunPart => ({ rule, label, max, pts: Math.round(max * clamp(frac, 0, 1)), why });
const fmt = (s: number) => `${s.toFixed(1)} s`;

function metrics(E: GunEngine, violations: number): GunScore['metrics'] {
  const hostiles = E.targets.filter((t) => t.hostile), kills = hostiles.filter((t) => t.state === 'destroyed').length;
  return { roundsFired: E.rounds.length, hits: E.rounds.filter((r) => r.hit).length, kills, hostiles: hostiles.length, leaked: hostiles.filter((t) => t.state === 'leaked').length,
    ammoPerKill: kills ? Math.round(E.rounds.length / kills) : null, violations, killRatePct: hostiles.length ? Math.round((100 * kills) / hostiles.length) : 100 };
}
function finish(game: GunGame, E: GunEngine, parts: GunPart[], deductions: GunPart[]): GunScore {
  const sum = parts.reduce((a, p) => a + p.pts, 0) + deductions.reduce((a, p) => a + p.pts, 0);
  const why = [...parts, ...deductions].flatMap((p) => p.why.map((w) => `${p.rule}: ${w}`));
  const rules = [...new Set([...parts, ...deductions].filter((p) => p.why.length || p.pts !== 0).map((p) => p.rule))];
  return { game, total: clamp(Math.round(sum), 0, 100), parts, deductions, why, rules, metrics: metrics(E, deductions.reduce((a, d) => a + d.why.length, 0)) };
}
const engageOrders = (E: GunEngine) => E.orders.filter((o) => o.o === 'engage');
/** Does this drill have hostile targets at all (spawned or still to come)? Parts with nothing to judge only get full marks when it has none. */
const hasHostiles = (E: GunEngine) => E.spawns.some((sp) => E.C.threats.threats[sp.type]?.hostile);
/** Hostiles that never appeared because the drill was ended early. */
const unseen = (E: GunEngine) => E.spawns.slice(E.next).filter((sp) => E.C.threats.threats[sp.type]?.hostile).length;

/** On Ground game: the gun detachment's drill (G1–G11). */
export function scoreGround(E: GunEngine): GunScore {
  const P = E.G.procedure, gun = E.gun, ev = (k: string) => E.ev.filter((e) => e.k === k);
  const radar = gun.sight === 'radar' && !E.cfg.radarFault;
  // G2 Make ready: acknowledge, man the gun, load before the executive order, lay on the indicated target.
  const w2: string[] = [];
  const ackC = avgOr(E.orders.map((o) => (o.ackTick == null ? 0 : lin(S(E, o.ackTick - o.tick), P.ackSec, P.ackSec * 3))));
  if (ackC < 0.99) w2.push(`Orders acknowledged late or not at all (${Math.round(ackC * 100)}% credit)`);
  let postC = 1;
  if ((E.cfg.adw ?? 'red') !== 'red') {
    const first = E.orders[0]?.tick ?? 0, posted = ev('posted')[0]?.tick;
    postC = posted == null ? 0 : lin(S(E, posted - first), (P.standToSec?.[E.cfg.adw!] ?? 0) + 2, (P.standToSec?.[E.cfg.adw!] ?? 0) + 15);
    if (postC < 1) w2.push(posted == null ? 'Never manned the gun' : `Manned the gun in ${fmt(S(E, posted - first))}`);
  }
  const eng0 = engageOrders(E)[0], loaded = ev('loaded')[0]?.tick;
  const loadC = !eng0 ? 1 : loaded == null ? 0 : loaded <= eng0.tick ? 1 : lin(S(E, loaded - eng0.tick), 0, 10);
  if (loadC < 1) w2.push(loaded == null ? 'Never loaded' : 'Not loaded when the executive order came');
  const layItems = E.orders.filter((o) => o.o === 'target' && tgt(E, o.cid)?.hostile).map((o) => {
    const done = E.ev.find((e) => e.tick >= o.tick && e.cid === o.cid && (e.k === (radar ? 'lock' : 'laid')));
    const onLine = E.bursts.find((b) => b.start >= o.tick && b.cid === o.cid);
    const at = done?.tick ?? onLine?.start;
    return at == null ? 0 : lin(S(E, at - o.tick), P.layWithinSec, P.layWithinSec * 3);
  });
  const layC = avgOr(layItems);
  if (layC < 0.99) w2.push(radar ? 'Slow to lock the radar on the indicated target' : 'Slow to lay on the indicated target');
  const g2 = part('G2', 'Make ready', 6, (3 * ackC + postC + 2 * loadC + 2 * layC) / 8, w2);
  // G3 Stoppages and barrel heat.
  const w3: string[] = [];
  const stops = ev('stoppage').map((s) => { const c = E.ev.find((e) => e.k === 'cleared' && e.tick > s.tick); return c ? lin(S(E, c.tick - s.tick), P.stoppageClearSec + 2, P.stoppageClearSec * 4) : 0; });
  if (stops.some((x) => x < 1)) w3.push('A stoppage was not cleared quickly with the immediate-action drill');
  const over = E.g.overheatRounds > 0;
  if (over) w3.push(`${E.g.overheatRounds} rounds fired past the barrel heat limit`);
  const g3 = part('G3', 'Stoppages and barrel heat', 4, avgOr(stops) - (over ? 0.5 : 0), w3);
  // G4 Reaction: executive order (or target entering engagement range) to first burst.
  const w4: string[] = [];
  const reacts = engageOrders(E).filter((o) => tgt(E, o.cid)?.hostile).map((o) => {
    const T = tgt(E, o.cid)!;
    let ref = o.tick; while (ref < E.tick && rangeAt(E, T, ref) > engageRange(E, T) * 1.05) ref++;
    const b = E.bursts.find((x) => x.start >= o.tick && x.cid === o.cid && x.authorised);
    if (!b) { w4.push(`No burst after the executive order on target ${o.cid}`); return 0; }
    const d = S(E, Math.max(0, b.start - ref));
    if (d > 3) w4.push(`First burst on target ${o.cid} after ${fmt(d)}`);
    return lin(d, 3, P.firstBurstWithinSec);
  });
  if (!reacts.length && hasHostiles(E)) w4.push('No executive order was carried out');
  const g4 = part('G4', 'Reaction to the fire order', 20, avgOr(reacts, hasHostiles(E) ? 0 : 1), w4);
  // G5 Ballistic solution: manual sight settings against the truth, or radar lock before firing.
  const w5: string[] = [], MS = E.G.manualSight;
  const firstBursts = [...new Map(E.bursts.filter((b) => b.authorised && b.cid != null).map((b) => [b.cid, b] as const)).values()];
  const sol = firstBursts.map((b) => {
    if (radar) { if (!b.locked) w5.push(`Burst on target ${b.cid} fired without a radar lock`); return b.locked ? 1 : 0.3; }
    const T = tgt(E, b.cid)!, t = b.start * E.dt, p = targetPos(T, t, E.dt), v = targetVel(T, t, E.dt), L = losOf(p);
    const spd = Math.hypot(v[0], v[1]), crs = angDiff(L.az + 180, (Math.atan2(v[0], v[1]) * 180) / Math.PI);
    const s = b.sight;
    if (!s) { w5.push(`Sight not set before firing on target ${b.cid}`); return 0; }
    const cs = Math.abs(s.spd - spd) <= MS.speedStepMs ? 1 : Math.abs(s.spd - spd) <= 2 * MS.speedStepMs ? 0.5 : 0;
    const cc = Math.abs(angDiff(s.crs, crs)) <= MS.courseStepDeg ? 1 : Math.abs(angDiff(s.crs, crs)) <= 2 * MS.courseStepDeg ? 0.5 : 0;
    const cr = Math.abs(s.rng - L.range) <= 0.15 * L.range ? 1 : Math.abs(s.rng - L.range) <= 0.3 * L.range ? 0.5 : 0;
    if (cs < 1) w5.push(`Target ${b.cid}: sight speed ${s.spd} m/s, actual about ${Math.round(spd)} m/s`);
    if (cc < 1) w5.push(`Target ${b.cid}: sight course ${s.crs}°, actual about ${Math.round(crs)}°`);
    if (cr < 1) w5.push(`Target ${b.cid}: sight range ${s.rng} m, actual about ${Math.round(L.range)} m`);
    return (cs + cc + cr) / 3;
  });
  const anyOrder = engageOrders(E).some((o) => tgt(E, o.cid)?.hostile);
  const g5 = part('G5', 'Ballistic solution', 10, sol.length ? avgOr(sol) : anyOrder || hasHostiles(E) ? 0 : 1, w5);
  // G6 Burst accuracy.
  const w6: string[] = [];
  const acc = E.bursts.filter((b) => b.authorised && b.cid != null).map((b) => {
    const T = tgt(E, b.cid)!, r = E.G.targets.hitRadiusM[E.C.threats.threats[T.type].echo] ?? 0.4;
    return b.hits > 0 || b.bestMiss <= r ? 1 : lin(b.bestMiss, r, r + 5);
  });
  const a6 = acc.length ? avgOr(acc) : anyOrder || hasHostiles(E) ? 0 : 1;
  if (acc.length) w6.push(`${acc.filter((x) => x === 1).length} of ${acc.length} bursts hit; average credit ${Math.round(a6 * 100)}%`);
  const g6 = part('G6', 'Burst accuracy', 20, a6, a6 < 1 ? w6 : []);
  // G7 Effect: hostiles ordered engaged that were destroyed before reaching the asset.
  const ordered = [...new Set(engageOrders(E).map((o) => o.cid))].map((id) => tgt(E, id)).filter((t): t is GunTarget => !!t && t.hostile);
  const w7 = ordered.filter((t) => t.state !== 'destroyed').map((t) => `Target ${t.id} (${E.C.threats.threats[t.type].short}) ${t.state === 'leaked' ? 'reached the asset' : 'was not destroyed'}`);
  if (!ordered.length && hasHostiles(E)) w7.push('No target was engaged');
  const g7 = part('G7', 'Targets destroyed', 20, ordered.length ? ordered.filter((t) => t.state === 'destroyed').length / ordered.length : hasHostiles(E) ? 0 : 1, w7);
  // G8 Burst discipline.
  const w8: string[] = [], bmax = P.burstMax * gun.barrels;
  for (const b of E.bursts) {
    if (b.rounds > bmax) w8.push(`Long burst of ${b.rounds} rounds (limit ${bmax})`);
    if (b.cid != null && b.maxRangeM > gun.effRangeM) w8.push(`Fired at ${Math.round(b.maxRangeM)} m, beyond the effective range of ${gun.effRangeM} m`);
  }
  const g8 = part('G8', 'Burst discipline', 8, 1 - w8.length * 0.2, w8);
  const g12 = reloadPart(E);
  // G9 Make safe and account.
  const w9: string[] = [], un = E.orders.find((o) => o.o === 'unload');
  let c9 = 1;
  if (!un) w9.push('No Unload order was given, so making safe was not tested');
  else {
    const safe = E.ev.find((e) => e.k === 'safetyOn' && e.tick >= un.tick) ?? (E.g.safety ? { tick: un.tick } : undefined);
    const unl = E.ev.find((e) => e.k === 'unloaded' && e.tick >= un.tick);
    const expended = E.cfg.issueRounds - E.g.reserve - E.g.ready;
    const sC = safe ? 1 : 0, uC = unl ? lin(S(E, unl.tick - un.tick), P.safeWithinSec, P.safeWithinSec * 3) : 0, rC = E.g.reported === expended ? 1 : 0;
    if (!sC) w9.push('Safety not applied after the Unload order');
    if (uC < 1) w9.push(unl ? `Unloaded in ${fmt(S(E, unl.tick - un.tick))}` : 'Gun not unloaded');
    if (!rC) w9.push(E.g.reported == null ? 'Rounds expended not reported' : `Reported ${E.g.reported} rounds expended; actual ${expended}`);
    c9 = (2 * sC + 2 * uC + 2 * rC) / 6;
  }
  const g9 = part('G9', 'Make safe and account', 6, c9, w9);
  // G11 Kill assessment report.
  const w11: string[] = [], killRep = E.targets.filter((t) => t.state === 'destroyed').map((t) => {
    const r = E.kills.find((k) => k.cid === t.id && k.out === 'destroyed');
    return r ? lin(S(E, r.tick - (t.endTick ?? r.tick)), P.killReportSec ?? 8, (P.killReportSec ?? 8) * 3) : 0;
  });
  const wrong = E.kills.filter((k) => k.out === 'destroyed' && tgt(E, k.cid)?.state !== 'destroyed').length;
  if (killRep.some((x) => x < 1)) w11.push('A destroyed target was not reported promptly');
  if (wrong) w11.push(`${wrong} target(s) reported destroyed that were not`);
  const g11 = part('G11', 'Kill assessment report', 2, wrong ? 0 : avgOr(killRep), w11);
  // Deductions: G1 firing without clearance (or after Hold fire, or on a friendly/civil aircraft), G10 safe arcs.
  const d1: string[] = [], d10: string[] = [];
  let p1 = 0, p10 = 0;
  for (const b of E.bursts) {
    const T = tgt(E, b.cid);
    if (T && !T.hostile) { p1 -= 40; d1.push(`Fired on a ${E.C.threats.threats[T.type].short.toLowerCase()} −40`); }
    else if (!b.authorised) { p1 -= 20; d1.push(`${b.afterHold ? 'Fired after HOLD FIRE' : 'Fired without clearance (no executive order on this target)'} at ${fmt(S(E, b.start))} −20`); }
    if (b.safeArc) { p10 -= 20; d10.push(`Fired into a safe arc at bearing ${Math.round(b.cid != null ? E.g.az : 0)}° −20`); }
  }
  const deductions = [{ rule: 'G1', label: 'Fire discipline: clearance', max: 0, pts: p1, why: d1 }, { rule: 'G10', label: 'Safe arcs', max: 0, pts: p10, why: d10 }];
  // L1 live-fire: gun checks done before loading.
  const lfx = E.G.lfx;
  if (lfx) {
    const loadAt = E.ev.find((e) => e.k === 'loading')?.tick ?? Infinity;
    const miss = lfx.gunChecks.filter((c) => E.checks[c.id] == null || E.checks[c.id] > loadAt);
    deductions.push({ rule: 'L1', label: 'Pre-firing gun checks', max: 0, pts: -4 * miss.length || 0, why: miss.map((c) => `Not done before loading: ${c.label} −4`) });
  }
  return finish('ground', E, [g2, g3, g4, g5, g6, g7, g8, g9, g11, g12], deductions);
}

/** G12 reload drill: each reload against the time standard (sum of the step times), with steps out of order costing credit. */
export function reloadPart(E: GunEngine, max = 4): GunPart {
  const R = E.gun.reload, std = R ? R.reduce((s, x) => s + x.sec, 0) : E.G.procedure.loadSec, w: string[] = [];
  const done = E.reloads.filter((r) => r.end != null);
  const items = done.map((r, i) => {
    const t = S(E, r.end! - r.start), c = Math.max(0, lin(t, std * 1.25, std * 3) - 0.25 * r.errors);
    if (r.errors) w.push(`Reload ${i + 1}: ${r.errors} step${r.errors > 1 ? 's' : ''} out of order`);
    if (t > std * 1.25) w.push(`Reload ${i + 1} took ${fmt(t)} (standard ${fmt(std)})`);
    return c;
  });
  const open = E.reloads.find((r) => r.end == null);
  if (open && open.errors) w.push(`An unfinished reload had ${open.errors} step(s) out of order`);
  return part('G12', 'Reload drill', max, items.length ? avgOr(items) - (open?.errors ? 0.25 : 0) : 0, items.length ? w : ['The gun was never loaded']);
}
/** Reload practice (no targets): the score is the reload drill alone, out of 100. */
export function scoreReload(E: GunEngine): GunScore { return finish('ground', E, [reloadPart(E, 100)], []); }

/** Control Room game: the fire-control officer's orders (F1–F8, plus G7 for the result). */
export function scoreControl(E: GunEngine): GunScore {
  const hostiles = E.targets.filter((t) => t.hostile), O = E.orders, ER = (T: GunTarget) => engageRange(E, T);
  const before = (k: OrderKind, tick: number, from: number) => O.some((o) => o.o === k && o.tick <= tick && o.tick >= from);
  // F1 Alert and indicate promptly.
  const w1: string[] = [], f1Items: number[] = [];
  if ((E.cfg.adw ?? 'red') !== 'red' && hostiles.length) {
    const first = Math.min(...hostiles.map((t) => t.spawnTick)), al = O.find((o) => o.o === 'alert');
    f1Items.push(al ? lin(S(E, al.tick - first), 3, 15) : 0);
    if (!al) w1.push('The detachment was never alerted');
  }
  for (const T of hostiles) {
    // Timed from when the contact was tracked, or from when the gun finished its previous engagement (one gun, one target at a time).
    const d = O.find((o) => o.o === 'target' && o.cid === T.id);
    const busyUntil = Math.max(0, ...hostiles.filter((o) => o !== T && o.endTick != null && O.some((x) => x.o === 'target' && x.cid === o.id && (!d || x.tick < d.tick))).map((o) => o.endTick!));
    const from = Math.max(T.spawnTick + T_(E, 1), busyUntil);
    if (!d) { w1.push(`Target ${T.id} was never indicated`); f1Items.push(0); continue; }
    const s = S(E, Math.max(0, d.tick - from)); f1Items.push(lin(s, 5, 20));
    if (s > 5) w1.push(`Target ${T.id} indicated after ${fmt(s)}`);
  }
  const f1 = part('F1', 'Alert and indicate', 15, avgOr(f1Items), w1);
  // F2 Fire-order sequence: Alert, Target, Method, Executive.
  const w2: string[] = [];
  const seq = engageOrders(E).map((e, i, all) => {
    const from = i ? all[i - 1].tick + 1 : 0, tOrd = [...O].reverse().find((o) => o.o === 'target' && o.tick <= e.tick && o.tick >= from);
    const okT = !!tOrd && tOrd.cid === e.cid, okM = !!tOrd && before('method', e.tick, tOrd.tick);
    const okA = (E.cfg.adw ?? 'red') === 'red' || before('alert', e.tick, 0);
    if (!okT) w2.push(`Executive order at ${fmt(S(E, e.tick))} without indicating that target first`);
    else if (!okM) w2.push(`Executive order at ${fmt(S(E, e.tick))} without a method`);
    if (!okA) w2.push('Executive order before the detachment was alerted');
    return ((okT ? 1 : 0) + (okM ? 1 : 0) + (okA ? 1 : 0)) / 3;
  });
  const f2 = part('F2', 'Fire-order sequence', 15, avgOr(seq, hasHostiles(E) ? 0 : 1), w2);
  // F5 Priority; F6 executive inside effective range with time to spare.
  const w5: string[] = [], w6: string[] = [];
  const pri = engageOrders(E).filter((e) => tgt(E, e.cid)?.hostile).map((e) => {
    const T = tgt(E, e.cid)!, mine = ttiAt(E, T, e.tick);
    const worse = hostiles.find((o) => o !== T && o.spawnTick <= e.tick && (o.endTick == null || o.endTick > e.tick) && ttiAt(E, o, e.tick) < mine * E.C.doctrine.defeat.modifiers.priorityRatio);
    if (worse) w5.push(`Target ${worse.id} was more urgent when target ${T.id} was engaged`);
    return worse ? 0 : 1;
  });
  const f5 = part('F5', 'Priority by time to impact', 10, avgOr(pri, hasHostiles(E) ? 0 : 1), w5);
  const rng = hostiles.map((T) => {
    const e = O.find((o) => o.o === 'engage' && o.cid === T.id);
    if (!e) { w6.push(`Target ${T.id} was never engaged`); return 0; }
    const r = rangeAt(E, T, e.tick), tt = ttiAt(E, T, e.tick);
    if (r > ER(T) * 1.05) { w6.push(`Target ${T.id} engaged at ${Math.round(r)} m, beyond its ${ER(T)} m engagement range (wasted rounds)`); return 0.5; }
    if (tt < E.C.doctrine.defeat.modifiers.lateEngagementSec) { w6.push(`Target ${T.id} engaged with only ${fmt(tt)} to impact`); return 0.3; }
    return 1;
  });
  for (let i = 0; i < unseen(E); i++) rng.push(0);
  if (unseen(E)) w6.push(`${unseen(E)} target(s) never reached: the drill ended early`);
  const f6 = part('F6', 'Executive order in range and in time', 15, avgOr(rng, hasHostiles(E) ? 0 : 1), w6);
  // F7 Cease fire after a kill; Hold fire when a friendly/civil aircraft enters the line of fire.
  const w7: string[] = [], f7Items: number[] = [];
  for (const T of hostiles.filter((t) => t.state === 'destroyed' || t.state === 'leaked')) {
    const wasCleared = O.some((o) => o.o === 'engage' && o.cid === T.id);
    if (!wasCleared || T.endTick == null) continue;
    const nextEngage = O.find((o) => o.o === 'engage' && o.tick > T.endTick!);
    const c = O.find((o) => (o.o === 'cease' || o.o === 'hold') && o.tick >= T.endTick! && (!nextEngage || o.tick <= nextEngage.tick));
    const switched = nextEngage && S(E, nextEngage.tick - T.endTick) <= 5;
    f7Items.push(switched ? 1 : c ? lin(S(E, c.tick - T.endTick), 5, 15) : 0);
    if (!switched && !c) w7.push(`No Cease fire after target ${T.id} was ${T.state}`);
  }
  for (const e of E.ev.filter((x) => x.k === 'nonHostileInLine')) {
    const h = O.find((o) => o.o === 'hold' && o.tick >= e.tick);
    f7Items.push(h ? lin(S(E, h.tick - e.tick), 2, 8) : 0);
    if (!h || S(E, h.tick - e.tick) > 2) w7.push(`HOLD FIRE ${h ? `after ${fmt(S(E, h.tick - e.tick))}` : 'never given'} when a friendly or civil aircraft crossed the line of fire`);
  }
  const f7 = part('F7', 'Cease fire and Hold fire', 15, avgOr(f7Items), w7);
  // F8 After the engagement: Cease fire, then Unload.
  const w8: string[] = [], lastEnd = Math.max(0, ...hostiles.map((t) => t.endTick ?? E.tick));
  const cease = O.find((o) => o.o === 'cease' && o.tick >= lastEnd - T_(E, 1)) ?? [...O].reverse().find((o) => o.o === 'cease');
  const unl = O.find((o) => o.o === 'unload');
  if (!cease) w8.push('No final Cease fire'); if (!unl) w8.push('No Unload order at the end');
  const f8 = part('F8', 'Close the engagement', 10, ((cease ? 1 : 0) + (unl ? lin(S(E, unl.tick - lastEnd), 10, 40) : 0)) / 2, w8);
  // Result.
  const kills = hostiles.filter((t) => t.state === 'destroyed').length, all = hostiles.length + unseen(E);
  const g7 = part('G7', 'Targets destroyed', 20, all ? kills / all : 1,
    hostiles.filter((t) => t.state !== 'destroyed').map((t) => `Target ${t.id} (${E.C.threats.threats[t.type].short}) ${t.state === 'leaked' ? 'reached the asset' : 'survived'}`));
  // Deductions: F3 Weapon Control Status, F4 safe arcs.
  const d3: string[] = [], d4: string[] = [];
  let p3 = 0, p4 = 0;
  for (const e of engageOrders(E)) {
    const T = tgt(E, e.cid);
    if (!T) continue;
    if (!T.hostile) { p3 -= 40; d3.push(`Ordered fire on a ${E.C.threats.threats[T.type].short.toLowerCase()} −40`); continue; }
    if ((E.cfg.wcs ?? 'tight') === 'hold' && ttiAt(E, T, e.tick) > SELF_DEFENCE_SEC) { p3 -= 20; d3.push(`Ordered fire under WEAPONS HOLD with ${fmt(ttiAt(E, T, e.tick))} to impact (not self-defence) −20`); }
    if (inSafeArc(E.cfg, losOf(targetPos(T, e.tick * E.dt, E.dt)).az)) { p4 -= 20; d4.push(`Ordered fire on target ${T.id} inside a safe arc −20`); }
  }
  const ded = [{ rule: 'F3', label: 'Weapon Control Status', max: 0, pts: p3, why: d3 }, { rule: 'F4', label: 'Safe arcs', max: 0, pts: p4, why: d4 }];
  const lfx = E.G.lfx;
  if (lfx) {
    // L2: range safety checks before RANGE CLEAR. L3: every unexploded round located before RANGE GREEN.
    const rc = O.find((o) => o.o === 'rangeClear')?.tick ?? Infinity;
    const miss = lfx.rangeChecks.filter((c) => E.checks[c.id] == null || E.checks[c.id] > rc);
    ded.push({ rule: 'L2', label: 'Range safety checks', max: 0, pts: -4 * miss.length || 0, why: miss.map((c) => `Not done before RANGE CLEAR: ${c.label} −4`) });
    const ux = unexploded(E), lost = ux.filter((r) => !E.uxoFound.includes(r.i)).length;
    const w3: string[] = [];
    if (E.rangeGreenTick == null) w3.push('RANGE GREEN never declared −5');
    if (lost) w3.push(`${lost} unexploded round(s) not located ${E.rangeGreenTick != null ? 'before RANGE GREEN' : ''} −${5 * lost}`);
    ded.push({ rule: 'L3', label: 'Range sweep (UXO)', max: 0, pts: -(E.rangeGreenTick == null ? 5 : 0) - 5 * lost || 0, why: w3 });
  }
  return finish('control', E, [f1, f2, f5, f6, f7, f8, g7], ded);
}

/** Skills tracked for the gun games (separate from the radar drill's SKILLS, so existing mastery is unchanged). */
export const GUN_SKILLS: [string, string, GunGame][] = [
  ['gReady', 'Make ready', 'ground'], ['gReact', 'Reaction', 'ground'], ['gLead', 'Ballistic solution', 'ground'], ['gAcc', 'Burst accuracy', 'ground'],
  ['gDisc', 'Fire discipline', 'ground'], ['gSafe', 'Make safe and report', 'ground'], ['gReload', 'Reload drill', 'ground'],
  ['fOrders', 'Alert, indicate, sequence', 'control'], ['fWcs', 'WCS and safe arcs', 'control'], ['fPriority', 'Priority and range', 'control'], ['fClose', 'Cease, hold, close', 'control'],
];
const SKILL_RULES: Record<string, string[]> = {
  gReady: ['G2'], gReact: ['G4'], gLead: ['G5'], gAcc: ['G6'], gDisc: ['G1', 'G8', 'G10'], gSafe: ['G3', 'G9', 'G11', 'L1'], gReload: ['G12'],
  fOrders: ['F1', 'F2', 'L2'], fWcs: ['F3', 'F4'], fPriority: ['F5', 'F6'], fClose: ['F7', 'F8', 'L3'],
};
/** One observation per skill per drill: right if every part of it earned at least 75% and no deduction hit it. */
export function observeGun(sc: GunScore): Observations {
  const o: Observations = {};
  for (const [k, , game] of GUN_SKILLS) {
    if (game !== sc.game) continue;
    const ps = [...sc.parts, ...sc.deductions].filter((p) => SKILL_RULES[k].includes(p.rule));
    if (!ps.length) continue;
    o[k] = [ps.every((p) => (p.max ? p.pts / p.max >= 0.75 : p.pts === 0))];
  }
  return o;
}
export interface GunRecord { n: number; date?: number; game: GunGame; cfg: GunDrillConfig; total: number; obs: Observations; metrics: GunScore['metrics']; rules: string[]; endTick: number; }
export function gunMastery(H: GunRecord[], C: Config = getConfig()): Record<string, number> {
  const m: Record<string, number> = {};
  for (const [k] of GUN_SKILLS) m[k] = bkt(H.flatMap((s) => s.obs[k] ?? []), C);
  return m;
}
