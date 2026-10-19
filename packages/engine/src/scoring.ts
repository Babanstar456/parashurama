import { decisionClass, isEffective } from './config';
import type { Contact, Engagement, Engine } from './types';
import { avg, clamp } from './util';

export interface ContactScore {
  c: Contact; src: Contact; D: number; C: number; F: number; Fbase: number; total: number;
  missed: boolean; rules: string[]; why: string[]; e0?: Engagement; det?: number;
}

const RULE_FOR = { rfLinked: 'R3', gnssOnly: 'R4', autonomous: 'R4' } as const;
const REASON = { rfLinked: 'Radio link present', gnssOnly: 'No radio link, GNSS-guided', autonomous: 'No radio link and no GNSS' } as const;

/** Score every contact against doctrine. Every point is traceable to a rule id in doctrine.json. */
export function scoreRun(E: Engine): ContactScore[] {
  const out: ContactScore[] = [];
  const Dc = E.C.doctrine, dt = E.C.training.sim.dt, EF = E.C.effectors.effectors;
  for (const c of E.contacts) {
    const Ty = E.C.threats.threats[c.type];
    let src = c;
    if (c.trackTick == null) {
      if (c.area && c.areaFrom != null) src = E.contacts.find((o) => o.id === c.areaFrom) ?? c;
      if (src.trackTick == null) {
        if (Ty.hostile) out.push({ c, src: c, D: 0, C: 0, F: 0, Fbase: 0, total: 0, missed: true, rules: ['D1', 'R8'], why: [c.state === 'leaked' ? 'Never tracked; it reached the asset' : 'Never tracked'] });
        continue;
      }
    }
    // Detection (D1)
    const det = ((src.trackTick as number) - (src.firstPaint ?? (src.trackTick as number))) * dt;
    const dd = Dc.detection;
    const D = Math.round(dd.points * clamp(1 - (det - dd.fullWithinSec) / (dd.zeroAtSec - dd.fullWithinSec), 0, 1));
    // Identification (C1)
    const I = Dc.identification;
    let Cs = 0;
    // A swarm drone taken out by an area effect before you identified it inherits the identification
    // of the drone you engaged (you correctly treated the group as one threat).
    const idSrc = !src.idCls && c.area && c.areaFrom != null ? E.contacts.find((o) => o.id === c.areaFrom) ?? src : src;
    const p = idSrc.idConf ?? 0;
    if (idSrc.idCls) {
      Cs = idSrc.idCls === c.type
        ? Math.round(I.correctBase + I.correctPerConfidence * p)
        : Math.round(I.wrongPerUnconfidence * (1 - p) + (E.C.threats.threats[idSrc.idCls].hostile === Ty.hostile ? I.friendFoeBonus : 0));
    }
    // Defeat (R1–R8)
    let e0: Engagement | undefined = src.engs[0];
    if (!e0 && c.area && c.areaFrom != null) {
      const af = E.contacts.find((o) => o.id === c.areaFrom);
      if (af && af.engs[0]) { e0 = af.engs[0]; c.areaCredit = true; }
    }
    const F0 = Dc.defeat, rules = ['D1', 'C1'], why: string[] = [];
    let F = 0;
    if (Ty.friendly) {
      rules.push('R1');
      if (!e0 || e0.eff === 'hold') { F = F0.friendlyHold; why.push('Friendly: held fire'); } else { F = F0.friendlyEngaged; why.push('Engaged a friendly UAV: fratricide'); }
    } else if (Ty.civil) {
      rules.push('R9');
      if (!e0 || e0.eff === 'hold') { F = F0.civilHold ?? 40; why.push('Civil drone: reported and monitored'); }
      else { F = F0.civilEngaged ?? 0; why.push('Engaged a civil drone: unlawful in peacetime airspace'); }
    } else if (!Ty.hostile) {
      rules.push('R2');
      if (!e0 || e0.eff === 'hold') { F = F0.clutterHold; why.push('Bird: no effector wasted'); } else { F = F0.clutterEngaged; why.push('Effector wasted on a bird'); }
    } else if (c.state === 'leaked') {
      F = 0; rules.push('R8'); why.push('Reached the protected asset');
    } else if (!e0 || e0.eff === 'hold') {
      F = c.state === 'neutralised' ? F0.hostileHeldButNeutralised : 0; rules.push('R8');
      why.push(!e0 ? (c.hover ? 'Left to watch the asset unchallenged' : 'Never engaged') : 'Held fire on a hostile');
    } else {
      const cls = decisionClass(Ty), ef = EF[e0.eff], pref = F0.preferred[cls];
      rules.push(RULE_FOR[cls]);
      F = isEffective(Ty, ef) ? F0.tables[cls][e0.eff] ?? 0 : 0;
      if (e0.eff === pref) why.push(`${REASON[cls]}: ${ef.label} was right`);
      else if (!isEffective(Ty, ef)) why.push(ef.affects === 'rf' ? 'Jammed a drone with no radio link: no effect' : `${ef.label} has no effect on this drone`);
      else why.push(`${ef.label} works, but ${EF[pref].label} was the better first choice`);
    }
    const Fbase = F, M = F0.modifiers;
    if (Ty.hostile && e0 && e0.eff !== 'hold' && c.state !== 'leaked') {
      if (EF[e0.eff]?.collateralUrban && E.cfg.terrain === 'urban') { F = Math.max(0, F + M.urbanGun); rules.push('R6'); why.push(`Gun in an urban area ${M.urbanGun}`); }
      if (isFinite(e0.tti) && e0.tti < M.lateEngagementSec) { F = Math.max(0, F + M.late); rules.push('R7'); why.push(`Under ${M.lateEngagementSec} s to impact ${M.late}`); }
      if (e0.priorityMiss) { F = Math.max(0, F + M.priority); rules.push('R5'); why.push(`A more urgent threat was waiting ${M.priority}`); }
    }
    out.push({ c, src, D, C: Cs, F, Fbase, e0, total: D + Cs + F, missed: false, rules, why, det });
  }
  return out;
}
export const runTotal = (sc: ContactScore[]): number => (sc.length ? Math.round(avg(sc.map((s) => s.total))) : 0);
