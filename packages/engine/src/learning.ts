import { getConfig, type Config } from './config';
import type { ContactScore } from './scoring';
import type { DrillConfig, Engine } from './types';
import { mulberry } from './util';

export const SKILLS: [string, string][] = [
  ['detect', 'Detection speed'], ['identify', 'Identification'], ['calib', 'Calibration'], ['defeat', 'Defeat choice'],
  ['timing', 'Timing'], ['night', 'Night'], ['swarm', 'Swarm'], ['degraded', 'Faulty sensors'], ['weather', 'Bad weather'], ['roe', 'Rules of engagement'],
];
export type Observations = Record<string, boolean[]>;
export type Mastery = Record<string, number>;
export type CalStats = Record<string, [number, number]>;
export interface SessionRecord {
  n: number; demo: boolean; date?: number; cfg: Partial<DrillConfig>; total: number; obs: Observations;
  attn: number[]; thr: number[]; cal: CalStats; jamNoRF: number; endTick?: number;
}

/** Bayesian knowledge tracing with forgetting: probability a skill is mastered, from a sequence of right/wrong observations. */
export function bkt(list: boolean[], C: Config = getConfig()): number {
  const { pInit, learn: L, forget: F, slip: S, guess: G } = C.training.learning;
  let p = pInit;
  for (const o of list) {
    const post = o ? (p * (1 - S)) / (p * (1 - S) + (1 - p) * G) : (p * S) / (p * S + (1 - p) * (1 - G));
    p = post * (1 - F) + (1 - post) * L;
  }
  return p;
}
export function mastery(H: SessionRecord[], C: Config = getConfig()): Mastery {
  const m: Mastery = {};
  for (const [k] of SKILLS) m[k] = bkt(H.flatMap((s) => s.obs[k] ?? []), C);
  return m;
}

/** Turn one drill into skill observations. Capped per drill so a single drill can never certify anyone. */
export function observe(E: Engine, sc: ContactScore[]): Observations {
  const o: Observations = {};
  for (const [k] of SKILLS) o[k] = [];
  const pass = E.C.training.certification.passMark;
  const certainP = E.C.doctrine.confidence[E.C.doctrine.confidence.length - 2]?.p ?? 0.8;
  const likelyP = E.C.doctrine.confidence[0].p;
  for (const s of sc) {
    const c = s.c, Ty = E.C.threats.threats[c.type];
    if (Ty.hostile) o.detect.push(s.D >= 20);
    if (s.src.idCls) {
      const ok = s.src.idCls === c.type;
      o.identify.push(ok);
      o.calib.push(ok ? (s.src.idConf ?? 0) >= certainP : (s.src.idConf ?? 1) <= likelyP);
    } else if (!s.missed) o.identify.push(false);
    if (Ty.hostile) {
      if (s.e0 && s.e0.eff !== 'hold') { o.defeat.push(s.Fbase >= 34); o.timing.push(isFinite(s.e0.tti) ? s.e0.tti >= E.C.doctrine.defeat.modifiers.lateEngagementSec : true); }
      else o.defeat.push(false);
    }
    const good = s.total >= pass;
    if (E.cfg.time === 'night') o.night.push(good);
    if (Ty.motion === 'swarm') o.swarm.push(good);
    if (E.cfg.fault !== 'none') o.degraded.push(good);
    if (E.cfg.weather && E.cfg.weather !== 'clear') o.weather.push(good);
    if (Ty.hostile && s.e0 && s.e0.eff !== 'hold' && (E.cfg.roe ?? 'free') !== 'free') o.roe.push(s.e0.cleared !== false);
  }
  const n = E.C.training.learning.maxObsPerDrill;
  for (const k of Object.keys(o)) {
    const l = o[k];
    if (l.length <= n) continue;
    const t = Math.round((l.filter(Boolean).length / l.length) * n);
    const a = Array.from({ length: n }, (_, i) => i < t);
    o[k] = a.filter((_, i) => i % 2 === 0).concat(a.filter((_, i) => i % 2 === 1));
  }
  return o;
}

export function calStats(sc: ContactScore[], C: Config = getConfig()): CalStats {
  const cal: CalStats = {};
  for (const lv of C.doctrine.confidence) cal[lv.k] = [0, 0];
  for (const s of sc) {
    if (!s.src.idCls || s.src !== s.c) continue;
    const lv = C.doctrine.confidence.find((x) => Math.abs(x.p - (s.src.idConf ?? -1)) < 0.01);
    if (!lv) continue;
    cal[lv.k][0]++;
    if (s.src.idCls === s.c.type) cal[lv.k][1]++;
  }
  return cal;
}
export function sumCal(list: SessionRecord[], C: Config = getConfig()): CalStats {
  const t: CalStats = {};
  for (const lv of C.doctrine.confidence) t[lv.k] = [0, 0];
  for (const s of list) for (const k in t) { t[k][0] += s.cal[k]?.[0] ?? 0; t[k][1] += s.cal[k]?.[1] ?? 0; }
  return t;
}

/** Five labelled demo sessions so a first-time user sees a meaningful fingerprint. */
export function demoHistory(C: Config = getConfig()): SessionRecord[] {
  const r = mulberry(4242);
  const H: SessionRecord[] = [];
  const totals = [51, 57, 60, 66, 63];
  const ks = C.doctrine.confidence.map((x) => x.k);
  for (let i = 0; i < 5; i++) {
    const obs: Observations = {};
    const P: Record<string, number> = { detect: 0.62 + i * 0.05, identify: 0.6 + i * 0.04, calib: 0.42, defeat: 0.5 + i * 0.03, timing: 0.62, night: 0.3 + i * 0.03, swarm: 0.26 + i * 0.03, degraded: 0.52, weather: 0.4 + i * 0.03 };
    // Skills without a demo probability (e.g. roe) get no observations and no random draws, so the demo history stays identical.
    for (const [k] of SKILLS) { obs[k] = []; if (!(k in P)) continue; const n = ['night', 'swarm', 'degraded', 'weather'].includes(k) ? 4 : 6; for (let j = 0; j < n; j++) obs[k].push(r() < P[k]); }
    const attn = [0.12, 0.11, 0.1, 0.1, 0.09, 0.1, 0.09, 0.08, 0.08, 0.07, 0.02, 0.04].map((v) => v * (0.85 + r() * 0.3));
    const thr = new Array(12).fill(0);
    for (let j = 0; j < 6; j++) thr[Math.floor(r() * 12)]++;
    thr[10]++;
    const cal: CalStats = {};
    ks.forEach((k, j) => { cal[k] = j === ks.length - 1 ? [4, 2 + (i > 2 ? 1 : 0)] : [3, 2]; });
    H.push({ n: i + 1, demo: true, total: totals[i], obs, attn, thr, cal, jamNoRF: i % 2, cfg: { time: i % 2 ? 'night' : 'day', fault: i === 3 ? 'radar' : 'none', pattern: i === 2 ? 'swarm' : 'mixed', terrain: 'urban', weather: i === 1 ? 'rain' : i === 4 ? 'fog' : 'clear' } });
  }
  return H;
}
