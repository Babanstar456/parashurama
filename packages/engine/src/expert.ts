import { decisionClass, isEffective, ticks } from './config';
import { inReach, isCleared, needsClearance, visibleBlip } from './engine';
import type { Action, Engine } from './types';

/** The expert ghost: doctrine-optimal choices with realistic human reaction times. */
export function expertPolicy(E: Engine): Action[] {
  const acts: Action[] = [];
  const t = E.tick, X = E.C.training.expert;
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
    const cls = decisionClass(Ty), want = E.C.doctrine.defeat.preferred[cls];
    // ROE: ask for clearance as soon as a hostile is identified, and fire only once cleared.
    if (c.clrReq == null && E.C.effectors.order.some((k) => needsClearance(E, k))) { acts.push({ k: 'req', cid: c.id, tick: t }); continue; }
    if (!last) { if (inReach(c, want, E.C) && isCleared(E, c, want)) acts.push({ k: 'eng', cid: c.id, eff: want, tick: t }); continue; }
    const EF = E.C.effectors.effectors, table = E.C.doctrine.defeat.tables[cls];
    const next = E.C.effectors.order.filter((k) => isEffective(Ty, EF[k]) && inReach(c, k, E.C) && isCleared(E, c, k) && (EF[k].stock == null || (E.stock[k] ?? 0) > 0))
      .sort((a, b) => (table[b] ?? 0) * (EF[b].pk ?? 1) - (table[a] ?? 0) * (EF[a].pk ?? 1))[0];
    if (next) acts.push({ k: 'eng', cid: c.id, eff: next, tick: t });
  }
  return acts;
}
