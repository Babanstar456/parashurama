import { angDiff, losOf } from './ballistics';
import { authorised, engageRange, inSafeArc, sightSolution, targetPos, targetVel, targetOnLine, type GunAction, type GunEngine, type GunTarget, type OrderKind } from './gun';
import { clamp } from './util';

/**
 * Doctrine-optimal AI seats for the gun drill. Both are stateless (they read only the engine), so a drill they play is
 * reproduced exactly from its log. They are:
 *  - the control room that gives orders in the On Ground game (and the expert ghost of the Control Room game);
 *  - the gun crew that obeys them in the Control Room game (and the expert ghost of the On Ground game).
 */
const sec = (E: GunEngine, s: number) => Math.round(s / E.dt);
const now = (E: GunEngine) => E.tick * E.dt;
/** Seconds until a target reaches the asset (Infinity if it never will). */
export function gunTti(E: GunEngine, T: GunTarget): number {
  if (!T.hostile || T.state !== 'live') return Infinity;
  const p = targetPos(T, now(E), E.dt), v = targetVel(T, now(E), E.dt);
  const h = Math.hypot(p[0], p[1]), closing = -(p[0] * v[0] + p[1] * v[1]) / (h || 1);
  return closing > 0.5 ? Math.max(0, (h - E.C.training.sim.assetRadiusM) / closing) : Infinity;
}
const rangeOf = (E: GunEngine, T: GunTarget) => losOf(targetPos(T, now(E), E.dt)).range;
const lastOrder = (E: GunEngine, kinds: OrderKind[]) => [...E.orders].reverse().find((o) => kinds.includes(o.o));
/** Seconds of self-defence window under Weapon Control Status HOLD. */
export const SELF_DEFENCE_SEC = 20;
/** Under the drill's Weapon Control Status, may the control room order fire on this target now? */
export function wcsAllows(E: GunEngine, T: GunTarget): boolean {
  if (!T.hostile) return false;
  const w = E.cfg.wcs ?? 'tight';
  return w === 'hold' ? gunTti(E, T) <= SELF_DEFENCE_SEC : true;
}
const bearingOf = (E: GunEngine, T: GunTarget) => losOf(targetPos(T, now(E), E.dt)).az;
/** A friendly or civil aircraft close to the gun's line of fire (deg). */
export function nonHostileInLine(E: GunEngine, maxDeg = 5): GunTarget | undefined {
  return E.targets.find((T) => T.state === 'live' && !T.hostile && (() => { const L = losOf(targetPos(T, now(E), E.dt)); return Math.hypot(angDiff(L.az, E.g.az), L.el - E.g.el) < maxDeg; })());
}

/** Expert control room: Range clear, Alert, Target, Method, Fire in sequence, by time to impact; Cease, Hold and Unload on time. */
export function controlRoomAI(E: GunEngine): GunAction[] {
  const o = (k: OrderKind, cid?: number): GunAction[] => [{ tick: E.tick, seat: 'cr', k: 'order', o: k, ...(cid != null ? { cid } : {}) }];
  if (!E.rangeClear) return o('rangeClear');
  const hostiles = E.targets.filter((T) => T.state === 'live' && T.hostile).sort((a, b) => gunTti(E, a) - gunTti(E, b));
  const cleared = E.cleared != null ? E.targets.find((T) => T.id === E.cleared) : undefined;
  // Emergency: a friendly or civil aircraft in the line of fire while cleared to fire.
  if (cleared && nonHostileInLine(E)) return o('hold');
  if (E.held && !nonHostileInLine(E, 7) && cleared === undefined) {
    const last = lastOrder(E, ['engage']);
    const T = last && E.targets.find((x) => x.id === last.cid);
    if (T && T.state === 'live' && rangeOf(E, T) <= engageRange(E, T) && !inSafeArc(E.cfg, bearingOf(E, T))) return o('engage', T.id);
  }
  // The cleared target is gone, or wandered into a safe arc: cease fire (keep tracking).
  if (cleared && (cleared.state !== 'live' || inSafeArc(E.cfg, bearingOf(E, cleared)))) return o('cease');
  if (!hostiles.length) {
    const pending = E.next < E.spawns.length;
    if (!pending && E.targets.some((x) => x.hostile)) {
      if (!E.ceased && !E.orders.some((x) => x.o === 'cease' && x.tick > (lastOrder(E, ['engage'])?.tick ?? -1))) return o('cease');
      if (!E.unloadOrdered && E.tick - (lastOrder(E, ['cease'])?.tick ?? E.tick) >= sec(E, 2)) return o('unload');
    }
    return [];
  }
  if ((E.cfg.adw ?? 'red') !== 'red' && !E.orders.some((x) => x.o === 'alert')) return o('alert');
  const T = hostiles[0];
  if (T.designatedTick != null && E.tick - T.designatedTick < 0) return [];
  // Contacts are tracked about 1 s after they appear.
  if (E.tick - T.spawnTick < sec(E, 1)) return [];
  // Finish the current engagement before switching; otherwise indicate the most urgent target.
  if (cleared && cleared.state === 'live' && cleared.id !== T.id) return [];
  const tgtOrder = lastOrder(E, ['target']);
  if (tgtOrder?.cid !== T.id) return o('target', T.id);
  if (tgtOrder?.cid === T.id && !E.orders.some((x) => x.o === 'method' && x.tick >= tgtOrder.tick)) return o('method');
  if (E.cleared !== T.id && tgtOrder?.cid === T.id && rangeOf(E, T) <= engageRange(E, T) && wcsAllows(E, T) && !inSafeArc(E.cfg, bearingOf(E, T)) && !nonHostileInLine(E, 7)) return o('engage', T.id);
  return [];
}

export interface CrewSkill { ackSec: number; }
/** Expert gun crew: acknowledge, man the gun, load, lay, set the sight (or lock the radar), fire short bursts on the order, clear stoppages, report, make safe. */
export function gunCrewAI(E: GunEngine, skill: CrewSkill = { ackSec: 1 }): GunAction[] {
  const g = E.g, gun = E.gun, P = E.G.procedure, out: GunAction[] = [];
  const a = (x: Omit<GunAction, 'tick' | 'seat'>) => out.push({ tick: E.tick, seat: 'gun', ...x } as GunAction);
  const un = E.orders.find((x) => x.ackTick == null);
  if (un && E.tick - un.tick >= sec(E, skill.ackSec)) a({ k: 'ack' });
  if (!E.orders.length) return out;
  if (!g.posted) { if (!g.busy) a({ k: 'post' }); return out; }
  // Make safe at the end.
  if (E.unloadOrdered) {
    if (g.trig) a({ k: 'trig', on: false });
    if (!g.safety) a({ k: 'safety', on: true });
    else if (!g.unloaded && !g.busy && (g.loaded || g.ready > 0)) a({ k: 'unload' });
    else if (!g.busy && g.reportTick == null) a({ k: 'report', n: E.cfg.issueRounds - g.reserve - g.ready });
    return out;
  }
  if (!g.loaded && !g.busy && g.reserve > 0) a({ k: 'load' });
  if (g.stoppage && !g.busy) { if (g.trig) a({ k: 'trig', on: false }); a({ k: 'clear' }); return out; }
  // Kill assessment.
  for (const T of E.targets) if (T.state === 'destroyed' && !E.kills.some((k) => k.cid === T.id) && E.tick - (T.endTick ?? 0) >= sec(E, 1)) a({ k: 'kill', cid: T.id, out: 'destroyed' });
  const des = [...E.orders].reverse().find((x) => x.o === 'target');
  const T = des?.cid != null ? E.targets.find((x) => x.id === des.cid) : undefined;
  const radar = gun.sight === 'radar' && !E.cfg.radarFault;
  if (T && T.state === 'live') {
    const L = losOf(targetPos(T, now(E), E.dt));
    if (radar) { if (g.lockCid !== T.id && L.range <= (gun.radar?.acquireRangeM ?? 0)) a({ k: 'lock', cid: T.id }); }
    else {
      const far = Math.hypot(angDiff(L.az, g.az), L.el - g.el) > gun.sightFovDeg / 2 - 1;
      if (far && g.layCid !== T.id) a({ k: 'lay', cid: T.id });
      if (!far) {
        // Set the manual sight to the target's speed, course angle and range (rounded to the sight's steps).
        const MS = E.G.manualSight, v = targetVel(T, now(E), E.dt), spd = Math.hypot(v[0], v[1]);
        const hdg = (Math.atan2(v[0], v[1]) * 180) / Math.PI, crs = angDiff(L.az + 180, hdg);
        const want = { spd: Math.round(spd / MS.speedStepMs) * MS.speedStepMs, crs: Math.round(crs / MS.courseStepDeg) * MS.courseStepDeg, rng: Math.round(L.range / MS.rangeStepM) * MS.rangeStepM };
        const s = g.sight;
        if (!s || s.spd !== want.spd || s.crs !== want.crs || s.rng !== want.rng) a({ k: 'sight', ...want });
        // Fine laying with the handwheels: keep the barrel on the sight's solution.
        const sol = sightSolution(E, E.fcs);
        if (sol?.ok) {
          E.fcs = sol;
          const rAz = clamp(angDiff(sol.az, g.az) / (gun.slewDegS.az * E.dt), -1, 1), rEl = clamp((sol.el - g.el) / (gun.slewDegS.el * E.dt), -1, 1);
          if (g.layCid == null && (Math.abs(rAz - g.rAz) > 1e-3 || Math.abs(rEl - g.rEl) > 1e-3)) a({ k: 'slew', az: +rAz.toFixed(4), el: +rEl.toFixed(4) });
        }
      }
    }
  }
  // Safety and trigger: fire only when cleared on this target, on the solution, in effective range; short bursts.
  const ok = T && T.state === 'live' && authorised(E, T.id) && !inSafeArc(E.cfg, g.az);
  if (ok && g.safety && g.loaded) a({ k: 'safety', on: false });
  if (!ok && !g.safety && (E.ceased || E.held)) a({ k: 'safety', on: true });
  const b = E.bursts[E.bursts.length - 1], perBarrel = Math.round((P.burstMin + P.burstMax) / 2);
  if (g.trig) {
    if (!ok || (b && b.end == null && b.rounds >= perBarrel * gun.barrels)) a({ k: 'trig', on: false });
  } else if (ok && g.loaded && !g.safety && !g.busy && T) {
    const L = losOf(targetPos(T, now(E), E.dt));
    const onLine = targetOnLine(E, gun.sightFovDeg / 2)?.id === T.id;
    const sol = radar ? E.fcs : sightSolution(E, E.fcs);
    const err = sol?.ok ? Math.hypot(angDiff(sol.az, g.az), sol.el - g.el) : 99;
    const rested = !b || b.end == null || E.tick - b.end >= sec(E, 1);
    const locked = !radar || (g.lockCid === T.id && g.lockStart != null && E.tick - g.lockStart >= sec(E, gun.radar?.lockSec ?? 0));
    if (onLine && locked && rested && err < 0.06 && L.range <= engageRange(E, T) * 1.05 && g.heat < gun.heatLimit * 0.9) a({ k: 'trig', on: true });
  }
  if (!g.trig && !g.busy && g.heat >= gun.heatLimit * 0.9) a({ k: 'barrel' });
  return out;
}
