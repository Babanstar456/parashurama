// After-action review across every drill kind (PS outcome 3): radar drills, the 3D field firing, Control Room, On Ground
// and the urban patrol. Three parts on the Unit readiness tab:
//   1. Progress over time: every drill's score against the pass mark, one line per drill kind.
//   2. Gun drills and patrol readiness: mastery per gun skill (learning model) and the recent patrol average, per operator.
//   3. One CSV of every drill.
// Offline (the public website) it reads this browser's own history; on a unit server it reads the server's records.
import { allDrillsToCsv, gunMastery, type AnyDrillRow, type GunRecord } from '@parashurama/engine';
import { app, hooks } from './app';
import { api, serverMode } from './online';
import { CERT } from './cfg';
import { gunHistory } from './gun';
import { patrolHistory } from './patrol';
import { recogHistory } from './recog';

interface PRec { date: number; total: number; cfg: any; metrics?: any }
const KIND_COL: Record<string, string> = { radar: '#3fa796', field: '#f2c94c', control: '#5da9ff', ground: '#c08bff', patrol: '#ff8a5c', recognition: '#e5484d' };
const KIND_LABEL: Record<string, string> = { radar: 'Radar drill', field: '3D field firing', control: 'Control Room', ground: 'On Ground', patrol: 'Urban patrol', recognition: 'Recognition (% right)' };
/** Gun-drill readiness columns: the 3D field drill's skills, the Control Room's (averaged), and the patrol's recent score. */
const COLS: [string, string][] = [['vDetect', 'Detect'], ['vIdent', 'Identify'], ['vDecide', 'Fire decision'], ['vShoot', 'Lead and shooting'], ['vDrill', 'Gun drill and safety'], ['control', 'Control Room'], ['patrol', 'Urban patrol']];
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** One operator's gun-drill row: mastery 0–1 per column (patrol: recent average score / 100), or null when never tried. */
function rowOf(G: GunRecord[], P: PRec[]): Record<string, number | null> {
  const m = gunMastery(G), tried = (g: string) => G.some((r) => r.game === g);
  const r: Record<string, number | null> = {};
  for (const [k] of COLS.slice(0, 5)) r[k] = tried('field') ? m[k] : null;
  r.control = tried('control') ? avg(['fOrders', 'fWcs', 'fPriority', 'fClose'].map((k) => m[k])) : null;
  r.patrol = P.length ? avg(P.slice(-5).map((x) => x.total)) / 100 : null;
  return r;
}
/** Demo rows for the offline board (clearly labelled; no real names). */
const DEMO: { n: string; v: Record<string, number | null> }[] = [
  { n: 'Demo operator A', v: { vDetect: 0.86, vIdent: 0.81, vDecide: 0.9, vShoot: 0.74, vDrill: 0.83, control: 0.79, patrol: 0.81 } },
  { n: 'Demo operator B', v: { vDetect: 0.62, vIdent: 0.55, vDecide: 0.7, vShoot: 0.48, vDrill: 0.66, control: null, patrol: 0.58 } },
  { n: 'Demo operator C', v: { vDetect: 0.91, vIdent: 0.88, vDecide: 0.93, vShoot: 0.85, vDrill: 0.9, control: 0.86, patrol: 0.88 } },
  { n: 'Demo operator D', v: { vDetect: 0.74, vIdent: 0.69, vDecide: 0.81, vShoot: 0.61, vDrill: 0.72, control: 0.64, patrol: null } },
];

function series(): { kind: string; date: number; total: number }[] {
  const out: { kind: string; date: number; total: number }[] = [];
  app.DB.H.forEach((r: any, i: number) => out.push({ kind: 'radar', date: r.date ?? i, total: r.total }));
  gunHistory().forEach((r, i) => out.push({ kind: r.game, date: r.date ?? i, total: r.total }));
  patrolHistory().forEach((r, i) => out.push({ kind: 'patrol', date: r.date ?? i, total: r.total }));
  recogHistory().forEach((r) => out.push({ kind: 'recognition', date: r.date, total: r.total }));
  return out.sort((a, b) => a.date - b.date);
}

/** Score over time, one line per drill kind, with the pass mark. Inline SVG, so it works offline. */
function chart(): string {
  const s = series();
  if (!s.length) return '<p class="aarEmpty">No drills yet. Every drill you finish appears here: radar, 3D field firing, Control Room and the urban patrol.</p>';
  const Wd = 720, Ht = 220, L = 34, R = 10, Tp = 10, B = 24, n = s.length, x = (i: number) => L + (n === 1 ? (Wd - L - R) / 2 : (i / (n - 1)) * (Wd - L - R)), y = (v: number) => Tp + (1 - v / 100) * (Ht - Tp - B);
  const kinds = [...new Set(s.map((p) => p.kind))];
  const lines = kinds.map((k) => {
    const pts = s.map((p, i) => ({ p, i })).filter((q) => q.p.kind === k);
    return `<polyline fill="none" stroke="${KIND_COL[k]}" stroke-width="2.2" points="${pts.map((q) => `${x(q.i).toFixed(1)},${y(q.p.total).toFixed(1)}`).join(' ')}"/>`
      + pts.map((q) => `<circle cx="${x(q.i).toFixed(1)}" cy="${y(q.p.total).toFixed(1)}" r="3.4" fill="${KIND_COL[k]}"><title>${KIND_LABEL[k]} · ${q.p.total}</title></circle>`).join('');
  }).join('');
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${L}" x2="${Wd - R}" y1="${y(v)}" y2="${y(v)}" stroke="currentColor" stroke-opacity="${v === CERT.passMark ? 0 : 0.12}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const pass = `<line x1="${L}" x2="${Wd - R}" y1="${y(CERT.passMark)}" y2="${y(CERT.passMark)}" stroke="#e5484d" stroke-dasharray="5 4" stroke-width="1.4"/><text x="${Wd - R}" y="${y(CERT.passMark) - 5}" text-anchor="end" fill="#e5484d">pass ${CERT.passMark}</text>`;
  const legend = kinds.map((k) => { const ks = s.filter((p) => p.kind === k), first = ks[0].total, last = ks[ks.length - 1].total;
    return `<span><i style="background:${KIND_COL[k]}"></i>${KIND_LABEL[k]} · ${ks.length} drill${ks.length === 1 ? '' : 's'} · last ${last}${ks.length > 1 ? ` (${last >= first ? '+' : ''}${last - first} since the first)` : ''}</span>`; }).join('');
  return `<svg class="aarChart" viewBox="0 0 ${Wd} ${Ht}" role="img" aria-label="Score over time for every drill">${grid}${pass}${lines}<text x="${L}" y="${Ht - 6}">first drill</text><text x="${Wd - R}" y="${Ht - 6}" text-anchor="end">latest</text></svg><div class="aarLegend">${legend}</div>`;
}

const cell = (v: number | null) => (v == null ? '<td class="num aarNa">–</td>' : `<td class="num ${v >= CERT.certifiedMastery ? 'st3' : v >= CERT.developingMastery ? 'st2' : 'st1'}">${Math.round(v * 100)}</td>`);
function table(rows: { n: string; me?: boolean; v: Record<string, number | null> }[]): string {
  return `<table class="board aarBoard"><tr><th>Operator</th>${COLS.map(([, l]) => `<th>${l}</th>`).join('')}</tr>${rows.map((o) => `<tr class="${o.me ? 'me' : ''}"><td>${esc(o.n)}</td>${COLS.map(([k]) => cell(o.v[k])).join('')}</tr>`).join('')}</table>`;
}

let unitRows: { n: string; me?: boolean; v: Record<string, number | null> }[] | null = null, loading = false;
async function loadUnit() {
  if (loading) return; loading = true;
  try {
    const [g, p] = await Promise.all([api('/api/gun/readiness'), api('/api/patrol/readiness')]);
    const pm = new Map<number, any>(p.operators.map((o: any) => [o.id, o]));
    unitRows = g.operators.map((o: any) => {
      const m = o.mastery, po = pm.get(o.id), v: Record<string, number | null> = {};
      for (const [k] of COLS.slice(0, 5)) v[k] = o.lastField != null ? m[k] : null;
      v.control = o.lastControl != null ? avg(['fOrders', 'fWcs', 'fPriority', 'fClose'].map((k) => m[k])) : null;
      v.patrol = po?.recent != null ? po.recent / 100 : null;
      return { n: o.name, me: o.name === app.TRAINEE.name, v };
    });
  } catch { unitRows = null; }
  loading = false; render();
}

export function render() {
  const el = document.getElementById('aarCard'); if (!el) return;
  const mine = { n: `${app.TRAINEE.name} (you)`, me: true, v: rowOf(gunHistory(), patrolHistory() as PRec[]) };
  const rows = serverMode ? unitRows ?? [mine] : [mine, ...DEMO];
  el.innerHTML = `<div class="cardHead"><h3>All drills · after-action review</h3><span>Radar, gun drills and urban patrol</span></div>
    <div class="aarBody">
      <h4>Your scores over time</h4>${chart()}
      <h4>Gun drills and patrol readiness</h4>
      <div class="wrapx">${table(rows)}</div>
      <div class="note">Mastery from the learning model for each gun-drill skill; Control Room is the average of its four skills; Urban patrol is the average of the last five patrols. – = not tried yet.${serverMode ? ' Records are the unit server’s, re-run and verified.' : ' Other rows are demo data; your row updates after every drill.'}</div>
      <div class="csvRow"><button class="smallBtn" id="aarCsv">Download every drill (CSV)</button></div>
    </div>`;
  (document.getElementById('aarCsv') as HTMLButtonElement).onclick = downloadAll;
  if (serverMode && !unitRows) void loadUnit();
}

function downloadAll() {
  if (serverMode) { const a = document.createElement('a'); a.href = '/api/export/all.csv'; a.download = 'parashurama-all-drills.csv'; a.click(); return; }
  const op = app.TRAINEE.name, unit = app.TRAINEE.unit, rows: AnyDrillRow[] = [];
  app.DB.H.forEach((r: any) => { const c = r.cfg ?? {}; rows.push({ operator: op, unit, kind: 'radar', date: r.date, time: c.time, terrain: c.terrain, weather: c.weather, difficulty: c.difficulty, seed: c.seed, total: r.total, hostiles: r.cls?.hostiles }); });
  gunHistory().forEach((r) => { const c = r.cfg; rows.push({ operator: op, unit, kind: r.game, date: r.date, gun: c.gun, time: c.time, terrain: c.terrain, weather: c.weather, difficulty: c.difficulty, seed: c.seed, total: r.total, kills: r.metrics?.kills, hostiles: r.metrics?.hostiles, struck: r.game === 'field' ? r.rules.includes('V4') : undefined }); });
  (patrolHistory() as any[]).forEach((r) => { const c = r.cfg ?? {}; rows.push({ operator: op, unit, kind: 'patrol', date: r.date, gun: 'zsu234', time: c.time, terrain: 'urban', weather: c.weather, difficulty: c.difficulty, seed: c.seed, total: r.total, kills: r.metrics?.kills, hostiles: r.metrics?.hostiles }); });
  recogHistory().forEach((r) => rows.push({ operator: op, unit, kind: 'recognition', date: r.date, total: r.total }));
  const blob = new Blob([allDrillsToCsv(rows, CERT.passMark)], { type: 'text/csv' }), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'parashurama-all-drills.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function initAar() { hooks.renderAar = render; }
