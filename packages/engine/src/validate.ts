import * as compiled from './generated/validators.js';
import { _setConfig, type Config, type DecisionClass } from './config';

// Kept separate from config.ts so browser bundles that never validate do not ship the schema validator.
// Validators are pre-compiled at build time (no eval at runtime): see scripts/gen-validators.ts
const validators = { threats: compiled.threats, effectors: compiled.effectors, doctrine: compiled.doctrine, training: compiled.training };

export interface ValidationResult { ok: boolean; errors: string[]; }

/** Schema checks plus cross-file checks (every id referenced anywhere must exist). */
export function validateConfig(c: Config): ValidationResult {
  const errors: string[] = [];
  (Object.keys(validators) as (keyof typeof validators)[]).forEach((k) => {
    const v = validators[k];
    if (!v(c[k])) for (const e of v.errors ?? []) errors.push(`${k}.json ${e.instancePath || '/'} ${e.message}`);
  });
  if (errors.length) return { ok: false, errors };
  const T = c.threats.threats, E = c.effectors.effectors, D = c.doctrine.defeat, S = c.training.scenario;
  for (const id of c.threats.order) if (!T[id]) errors.push(`threats.json order lists unknown threat "${id}"`);
  for (const id of Object.keys(T)) {
    const t = T[id];
    if (!c.threats.order.includes(id)) errors.push(`threats.json threat "${id}" is missing from order`);
    if (!(t.echo in c.threats.echoRcs)) errors.push(`threats.json threat "${id}" uses unknown echo size "${t.echo}"`);
    if (t.alt[0] > t.alt[1]) errors.push(`threats.json threat "${id}" has alt min > max`);
    if (t.friendly && t.hostile) errors.push(`threats.json threat "${id}" cannot be both friendly and hostile`);
    if (t.civil && (t.hostile || t.friendly)) errors.push(`threats.json threat "${id}": a civil drone cannot be hostile or friendly`);
    if (t.motion === 'orbit' && t.hostile) errors.push(`threats.json threat "${id}": orbit motion is only for non-hostile contacts (use surveil for hostile drones that circle)`);
    if (t.motion === 'surveil' && !t.hostile) errors.push(`threats.json threat "${id}": surveil motion is only for hostile contacts`);
    const or = t.orbitRadiusM;
    if (t.motion === 'surveil' && or && (or[0] > or[1] || or[1] >= c.training.sim.radarRangeM)) errors.push(`threats.json threat "${id}": orbitRadiusM must be min <= max and inside radar range`);
  }
  for (const id of c.effectors.order) if (!E[id]) errors.push(`effectors.json order lists unknown effector "${id}"`);
  for (const id of Object.keys(E)) {
    if (!c.effectors.order.includes(id)) errors.push(`effectors.json effector "${id}" is missing from order`);
    if (E[id].min >= E[id].range) errors.push(`effectors.json effector "${id}" has min >= range`);
  }
  const keys = c.effectors.order.map((k) => E[k]?.key);
  if (new Set(keys).size !== keys.length) errors.push('effectors.json: two effectors share the same key');
  for (const cls of ['rfLinked', 'gnssOnly', 'autonomous'] as DecisionClass[]) {
    if (!E[D.preferred[cls]]) errors.push(`doctrine.json preferred.${cls} names unknown effector "${D.preferred[cls]}"`);
    for (const eff of Object.keys(D.tables[cls])) if (!E[eff]) errors.push(`doctrine.json tables.${cls} names unknown effector "${eff}"`);
    for (const eff of c.effectors.order) if (!(eff in D.tables[cls])) errors.push(`doctrine.json tables.${cls} has no points for effector "${eff}"`);
    for (const v of Object.values(D.tables[cls])) if (v > D.points) errors.push(`doctrine.json tables.${cls} awards more than defeat.points`);
  }
  for (const [name, prof] of Object.entries(c.doctrine.roe ?? {})) for (const eff of prof?.needsClearance ?? []) if (!E[eff]) errors.push(`doctrine.json roe.${name} names unknown effector "${eff}"`);
  if (c.doctrine.roe && Object.keys(c.doctrine.roe).length && !c.doctrine.rules.R12) errors.push('doctrine.json needs rule R12 when ROE profiles are defined');
  const ps = c.doctrine.confidence.map((x) => x.p);
  if (ps.some((p, i) => i > 0 && p <= ps[i - 1])) errors.push('doctrine.json confidence levels must increase');
  const ck = c.doctrine.confidence.map((x) => x.key);
  if (ck.some((k) => keys.includes(k))) errors.push('doctrine.json a confidence key clashes with an effector key');
  const d = c.doctrine;
  if (d.detection.points + d.identification.points + d.defeat.points !== 100) errors.push('doctrine.json detection + identification + defeat points must total 100');
  if (d.detection.fullWithinSec >= d.detection.zeroAtSec) errors.push('doctrine.json detection.fullWithinSec must be below zeroAtSec');
  for (const id of [...S.hostilePool, S.swarmType, S.friendlyType, S.clutterType, S.focusType]) if (!T[id]) errors.push(`training.json scenario names unknown threat "${id}"`);
  for (const id of S.hostilePool) if (T[id] && !T[id].hostile) errors.push(`training.json hostilePool contains non-hostile "${id}"`);
  if (S.civilType && !T[S.civilType]) errors.push(`training.json scenario names unknown civilType "${S.civilType}"`);
  if (S.civilType && T[S.civilType] && !T[S.civilType].civil) errors.push(`training.json civilType "${S.civilType}" must be a civil threat`);
  if (Object.values(T).some((t) => t.civil) && !c.doctrine.rules.R9) errors.push('doctrine.json needs rule R9 when the library has a civil drone');
  if (T[S.swarmType] && T[S.swarmType].motion !== 'swarm') errors.push('training.json swarmType must use swarm motion');
  if (c.training.certification.developingMastery >= c.training.certification.certifiedMastery) errors.push('training.json developingMastery must be below certifiedMastery');
  return { ok: errors.length === 0, errors };
}

/** Swap the active config (e.g. a unit's threat pack). Throws with readable messages if invalid. */
export function useConfig(c: Config): void {
  const r = validateConfig(c);
  if (!r.ok) throw new Error('Invalid config:\n' + r.errors.join('\n'));
  _setConfig(c);
}
