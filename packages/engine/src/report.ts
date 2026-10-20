import type { Config } from './config';
import type { ContactScore } from './scoring';

/** Per-drill classification evidence: how many contacts were identified correctly, engaged wrongly, or never tracked. */
export interface ClassificationStats {
  contacts: number; hostiles: number; identified: number; correct: number;
  /** correct / contacts (0–1): every contact counts, so an unidentified contact lowers it. */
  idRate: number;
  /** Non-hostile contacts (friendly UAV or bird) that were engaged. */
  falsePositives: number;
  /** Hostile contacts that were never tracked. */
  missedHostiles: number;
  /** Hostile contacts that reached the protected asset. */
  leaked: number;
}

export function classificationStats(sc: ContactScore[], C: Config): ClassificationStats {
  const T = C.threats.threats;
  const hostile = sc.filter((s) => T[s.c.type].hostile);
  const identified = sc.filter((s) => s.src.idCls && s.src.idCls !== 'unknown').length;
  const correct = sc.filter((s) => s.src.idCls === s.c.type).length;
  return {
    contacts: sc.length, hostiles: hostile.length, identified, correct,
    idRate: sc.length ? correct / sc.length : 0,
    falsePositives: sc.filter((s) => !T[s.c.type].hostile && s.e0 && s.e0.eff !== 'hold').length,
    missedHostiles: hostile.filter((s) => s.missed).length,
    leaked: hostile.filter((s) => s.c.state === 'leaked').length,
  };
}

/** One drill as exported. `record` is the stored history record (server-verified on the unit server). */
export interface CsvDrill { operator: string; unit?: string; verified?: boolean | null; record: any; /** Study cohort ('adaptive' or 'control'). */ cohort?: string; }

const COLUMNS = ['operator', 'unit', 'drill', 'date', 'mode', 'template', 'time', 'terrain', 'weather', 'fault', 'pattern', 'difficulty', 'seed',
  'total', 'passed', 'verified', 'contacts', 'hostiles', 'correct_ids', 'id_rate_pct', 'false_positives', 'missed_hostiles', 'leaked', 'cohort'] as const;
const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // Quote when needed, and neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Drill history as CSV (one row per drill) for spreadsheets and after-action review. */
export function drillsToCsv(drills: CsvDrill[], passMark: number): string {
  const rows = drills.map(({ operator, unit, verified, record: r, cohort }, i) => {
    const c = r.cfg ?? {}, k = r.cls as ClassificationStats | undefined;
    return [operator, unit ?? '', r.n ?? i + 1, r.date != null ? new Date(r.date).toISOString() : '', r.mode ?? 'scored', r.template ?? '',
      c.time, c.terrain, c.weather ?? 'clear', c.fault, c.pattern, c.difficulty, c.seed,
      r.total, r.total >= passMark ? 'yes' : 'no', verified == null ? '' : verified ? 'yes' : 'no',
      k?.contacts, k?.hostiles, k?.correct, k ? Math.round(k.idRate * 100) : '', k?.falsePositives, k?.missedHostiles, k?.leaked, cohort ?? ''];
  });
  return [COLUMNS as readonly unknown[], ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
