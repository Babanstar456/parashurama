import { decisionClass, isEffective, ticks } from './config';
import { inReach, isCleared, needsClearance, tti, visibleBlip } from './engine';
import { brgOf } from './util';
import type { Action, Engine } from './types';

/** The expert ghost: doctrine-optimal choices with realistic human reaction times. */
export function expertPolicy(E: Engine): Action[] {
  const acts: Action[] = [];
  const t = E.tick, X = E.C.training.expert, M = E.C.doctrine.defeat.modifiers;
  // Kill assessment (only when the drill asks for it): report each kill a second after it.
  if (E.cfg.killAssess) for (const c of E.contacts) if (c.state === 'neutralised' && c.bdaTick == null && c.endTick != null && t >= c.endTick + ticks(E.C, 1) && E.C.threats.threats[c.type].hostile) acts.push({ k: 'bda', cid: c.id, out: 'destroyed', tick: t });
  const arcs = E.cfg.safeArcs, inArc = (c: { x: number; y: number }) => !!arcs && arcs.some(([a, z]) => { const b = brgOf(c.x, c.y); return a <= z ? b >= a && b <= z : b >= a || b <= z; });
  /** Effectors the expert may use on this contact now: no gun into a safe arc. */
  const allowed = (c: { x: number; y: number }, k: string) => !(E.C.effectors.effectors[k].collateralUrban && inArc(c));
  for (const c of E.contacts) {
    if (c.state !== 'live' || c.effectAt != null) continue;
    if (c.trackTick == null) {
      if (c.firstPaint != null && t >= c.firstPaint + ticks(E.C, X.trackDelaySec) && visibleBlip(E, c)) acts.push({ k: 'track', cid: c.id, tick: t });
      continue;
    }
    if (c.idTick == null) {
      if (t >= c.trackTick + ticks(E.C, X.identifyDelaySec)) acts.push({ k: 'id', cid: c.id, cls: c.type, conf: E.C.doctrine.confidence[E.C.doctrine.confidence.length - 1].p, tick: t });
      continue;
    }
    const Ty = E.C.threats.threats[c.type];
    const last = c.engs[c.engs.length - 1];
    // Engage once; engage again only after a miss (pk < 1), with the effector of highest expected value (points × pk) in reach.
    if (last && !(Ty.hostile && last.miss)) continue;
    if (!Ty.hostile) { acts.push({ k: 'eng', cid: c.id, eff: 'hold', tick: t }); continue; }
    // Weapon Control Status HOLD: engage only in self-defence.
    if (E.cfg.wcs === 'hold' && !(tti(c, E.C) <= (M.selfDefenceSec ?? 20))) continue;
    const cls = decisionClass(Ty), pref = E.C.doctrine.defeat.preferred[cls];
    const EFx = E.C.effectors.effectors, tbl = E.C.doctrine.defeat.tables[cls];
    const want = allowed(c, pref) ? pref : E.C.effectors.order.filter((k) => k !== pref && isEffective(Ty, EFx[k]) && allowed(c, k)).sort((a, b) => (tbl[b] ?? 0) - (tbl[a] ?? 0))[0] ?? pref;
    if (!allowed(c, want)) continue;
    // ROE: ask for clearance as soon as a hostile is identified, and fire only once cleared.
    if (c.clrReq == null && E.C.effectors.order.some((k) => needsClearance(E, k))) { acts.push({ k: 'req', cid: c.id, tick: t }); continue; }
    if (!last) { if (inReach(c, want, E.C) && isCleared(E, c, want)) acts.push({ k: 'eng', cid: c.id, eff: want, tick: t }); continue; }
    const EF = E.C.effectors.effectors, table = E.C.doctrine.defeat.tables[cls];
    const next = E.C.effectors.order.filter((k) => isEffective(Ty, EF[k]) && allowed(c, k) && inReach(c, k, E.C) && isCleared(E, c, k) && (EF[k].stock == null || (E.stock[k] ?? 0) > 0))
      .sort((a, b) => (table[b] ?? 0) * (EF[b].pk ?? 1) - (table[a] ?? 0) * (EF[a].pk ?? 1))[0];
    if (next) acts.push({ k: 'eng', cid: c.id, eff: next, tick: t });
  }
  return acts;
}
