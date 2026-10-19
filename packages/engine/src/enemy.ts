import { getConfig, type Config } from './config';
import { mastery, sumCal, type Mastery, type SessionRecord } from './learning';
import type { DrillConfig, Fault, Weather } from './types';
import { avg, clamp, mulberry, windOf } from './util';

export const COND_LABEL: Record<string, string> = { night: 'night drills', swarm: 'swarm attacks', degraded: 'faulty sensors', weather: 'bad weather' };
export const FAULT_LABEL: Record<Fault, string> = { none: 'All healthy', radar: 'Radar fault', eo: 'Camera degraded', rf: 'RF detector off' };
export const WEATHER_LABEL: Record<Weather, string> = { clear: 'Clear', rain: 'Heavy rain', fog: 'Dense fog', dust: 'Dust storm' };
export interface IntelLine { b: string; t: string; }
export interface Plan { cfg: DrillConfig; lines: IntelLine[]; tests: string[]; m: Mastery; }

/** Control group: same seeding, but conditions are drawn at random and nothing targets the trainee's weaknesses. */
function controlPlan(seed: number, drill: number, m: Mastery): Plan {
  const r = mulberry(seed ^ 0xc0de);
  const cfg: DrillConfig = { seed, drill, time: 'day', terrain: r() < 0.5 ? 'urban' : 'rural', fault: 'none', faultSector: Math.floor(r() * 12) * 30 + 15, pattern: 'mixed', weather: 'clear', difficulty: 3, focus: { sector: null, loiter: false, decoy: false } };
  const k = (['night', 'swarm', 'degraded', 'weather'] as const)[Math.floor(r() * 4)];
  if (k === 'night') cfg.time = 'night';
  if (k === 'swarm') cfg.pattern = 'swarm';
  if (k === 'degraded') cfg.fault = (['radar', 'eo', 'rf'] as Fault[])[Math.floor(r() * 3)];
  if (k === 'weather') cfg.weather = (['rain', 'fog', 'dust'] as Weather[])[Math.floor(r() * 3)];
  return { cfg, lines: [{ b: 'Control group.', t: ' Fixed difficulty (level 3) and random conditions, so your progress can be compared with adaptive training.' }], tests: [COND_LABEL[k]], m };
}

/** The enemy AI: builds the next drill around the trainee's measured weaknesses. Rule-based and explainable. */
/** Options: `adaptive: false` = control group (fixed level 3, random conditions, no targeting) for measuring training transfer. */
export interface PlanOpts { adaptive?: boolean; }
export function planNext(H: SessionRecord[], C: Config = getConfig(), opts: PlanOpts = {}): Plan {
  if (!H.length) {
    // First drill ever: nothing to exploit yet, so a gentle, balanced daytime drill.
    const cfg: DrillConfig = { seed: 20261, drill: 1, time: 'day', terrain: 'rural', fault: 'none', faultSector: 0, pattern: 'mixed', weather: 'clear', difficulty: 2, focus: { sector: null, loiter: false, decoy: false } };
    return { cfg, lines: [{ b: 'No drills yet.', t: ' The enemy starts studying your habits after your first drill.' }], tests: ['the basics: detect, identify, defeat'], m: mastery(H, C) };
  }
  const m = mastery(H, C);
  const last = H.slice(-5);
  const drill = H.length + 1;
  const seed = (drill * 7919 + (H.length ? H[H.length - 1].total * 131 : 0) + 20260) >>> 0;
  const r = mulberry(seed);
  const conds = ([['night', m.night], ['swarm', m.swarm], ['degraded', m.degraded], ['weather', m.weather]] as [string, number][]).sort((a, b) => a[1] - b[1]);
  if (opts.adaptive === false) return controlPlan(seed, drill, m);
  const cfg: DrillConfig = { seed, drill, time: 'day', terrain: r() < 0.5 ? 'urban' : 'rural', fault: 'none', faultSector: 0, pattern: 'mixed', weather: 'clear', difficulty: 3, focus: { sector: null, loiter: false, decoy: false } };
  const applyC = (k: string) => {
    if (k === 'night') cfg.time = 'night';
    if (k === 'swarm') cfg.pattern = 'swarm';
    if (k === 'degraded') cfg.fault = (['radar', 'eo', 'rf'] as Fault[])[Math.floor(r() * 3)];
    if (k === 'weather') cfg.weather = (['rain', 'fog', 'dust'] as Weather[])[Math.floor(mulberry(seed ^ 0x5eed)() * 3)];
  };
  applyC(conds[0][0]);
  if (conds[1][1] < 0.6) applyC(conds[1][0]);
  const att = new Array(12).fill(0);
  last.forEach((s) => s.attn.forEach((v, i) => (att[i] += v)));
  const tot = att.reduce((a, b) => a + b, 0) || 1;
  const share = att.map((v) => v / tot);
  let ng = 0;
  share.forEach((v, i) => { if (v < share[ng]) ng = i; });
  cfg.focus.sector = ng * 30 + 15;
  cfg.faultSector = cfg.fault === 'radar' ? ng * 30 + 15 : (ng * 30 + 195) % 360;
  const jamNoRF = last.reduce((a, s) => a + (s.jamNoRF || 0), 0);
  if (jamNoRF > 0) cfg.focus.loiter = true;
  const cal = sumCal(last, C);
  if (m.calib < 0.6) cfg.focus.decoy = true;
  const avg3 = avg(H.slice(-3).map((s) => s.total));
  cfg.difficulty = clamp(3 + (avg3 > 82 ? 1 : 0) - (avg3 < 55 ? 1 : 0) + Math.floor(H.length / 4), 1, 6);
  const top = C.doctrine.confidence[C.doctrine.confidence.length - 1];
  const lines: IntelLine[] = [];
  lines.push({ b: `You gave the ${windOf(cfg.focus.sector)} ${Math.max(1, Math.round(share[ng] * 100))}% of your attention`, t: ` across your last ${last.length} drills, the least of any sector.` });
  if (jamNoRF) lines.push({ b: `You jammed ${jamNoRF} drone${jamNoRF > 1 ? 's' : ''} that had no radio link.`, t: ' Jamming does nothing to those.' });
  if (cal[top.k]?.[0]) lines.push({ b: `When you said “${top.label}”, you were right ${Math.round((100 * cal[top.k][1]) / cal[top.k][0])}% of the time.`, t: ` ${top.label} should mean about ${Math.round(top.p * 100)}%.` });
  if (lines.length < 3) lines.push({ b: `Your weakest condition is ${COND_LABEL[conds[0][0]]}`, t: ` (mastery ${Math.round(conds[0][1] * 100)}%).` });
  const tests = [COND_LABEL[conds[0][0]]];
  if (cfg.weather && cfg.weather !== 'clear' && conds[0][0] !== 'weather') tests.push(`${WEATHER_LABEL[cfg.weather].toLowerCase()}`);
  if (cfg.focus.loiter) tests.push(C.threats.threats[C.training.scenario.focusType].label.toLowerCase() + 's');
  tests.push(`threats from the ${windOf(cfg.focus.sector)}`);
  if (cfg.focus.decoy) tests.push('look-alike decoys');
  return { cfg, lines: lines.slice(0, 3), tests, m };
}
