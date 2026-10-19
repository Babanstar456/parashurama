// Online (unit server) mode: automatic sign-in (no login screen), server history, drill sync with server-side verification, readiness board.
// Falls back to offline mode automatically when no server answers (file://, single laptop, LAN down).
import { toast } from './toast';

export interface Session { user: any; config: any | null; history: any[]; templates: any[]; }
const OUTBOX = 'parashurama.outbox';
async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(path, { credentials: 'same-origin', headers: init.body != null ? { 'content-type': 'application/json' } : {}, ...init });
  const body = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw Object.assign(new Error(body?.error || r.statusText), { status: r.status, body });
  return body;
}
export { api };
export async function detectServer(): Promise<boolean> {
  if (location.protocol === 'file:') return false;
  try { const r = await fetch('/api/health', { cache: 'no-store' }); return r.ok && !!(await r.json()).ok; } catch { return false; }
}
// No login screen: the app signs in to the server's built-in admin account automatically.
const AUTO_USER = 'admin';
const autoSignIn = async () => (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ name: AUTO_USER }) })).user;
export async function startSession(): Promise<Session> {
  let user: any;
  try { user = (await api('/api/me')).user; } catch { user = await autoSignIn(); }
  const [cfg, hist, tpl] = await Promise.all([api('/api/config').catch(() => null), api('/api/drills/mine').catch(() => ({ drills: [] })), api('/api/templates').catch(() => ({ templates: [] }))]);
  return { user, config: cfg?.custom ? cfg.config : null, history: hist.drills, templates: tpl.templates };
}
async function flushOutbox(chip: HTMLElement) {
  let box: any[] = []; try { box = JSON.parse(localStorage.getItem(OUTBOX) || '[]'); } catch { box = []; }
  const left: any[] = [];
  for (const d of box) { try { await api('/api/drills', { method: 'POST', body: JSON.stringify(d) }); } catch { left.push(d); } }
  localStorage.setItem(OUTBOX, JSON.stringify(left));
  if (box.length && !left.length) toast(`Synced ${box.length} drill${box.length > 1 ? 's' : ''} saved while offline`);
  chip.textContent = left.length ? `${left.length} waiting to sync` : 'Synced'; chip.className = 'sync ' + (left.length ? 'warn' : 'ok');
}
export function initOnline(app: any, hooks: any, on: any, s: Session) {
  const chip = document.getElementById('syncChip')!; chip.hidden = false;
  app.TRAINEE.name = s.user.name; app.TRAINEE.unit = s.user.unit;
  document.getElementById('whoName')!.textContent = s.user.name;
  document.getElementById('whoUnit')!.textContent = `${s.user.unit} · ${s.user.role}`;
  if (s.user.settings) { Object.assign(app.DB, { academy: s.user.settings.academy || app.DB.academy, settings: s.user.settings.settings || app.DB.settings, tourDone: s.user.settings.tourDone ?? app.DB.tourDone }); }
  const pushSettings = () => api('/api/me/settings', { method: 'PUT', body: JSON.stringify({ academy: app.DB.academy, settings: app.DB.settings, tourDone: app.DB.tourDone }) }).catch(() => null);
  on('finish', pushSettings); on('brief', pushSettings);
  hooks.syncDrill = async (rec: any, R: any) => {
    const payload = { cfg: R.cfg, spawns: R.spawns ?? null, actions: R.acts, endTick: R.endTick, attn: rec.attn, mode: R.mode, template: R.template, clientTotal: R.total };
    try {
      const r = await api('/api/drills', { method: 'POST', body: JSON.stringify(payload) });
      R.server = r; chip.textContent = 'Synced'; chip.className = 'sync ok';
      const out = document.getElementById('integrity');
      if (out) out.insertAdjacentHTML('beforeend', `<span>Unit server: <b class="${r.verified ? 'good' : 'bad'}">${r.verified ? `verified independently (${r.total})` : `score corrected to ${r.total}`}</b>${r.flags?.length ? ` · flags: ${r.flags.join(', ')}` : ''}</span>`);
    } catch {
      const box = JSON.parse(localStorage.getItem(OUTBOX) || '[]'); box.push(payload); localStorage.setItem(OUTBOX, JSON.stringify(box));
      chip.textContent = `${box.length} waiting to sync`; chip.className = 'sync warn'; toast('Server unreachable. The drill is saved and will sync later.');
    }
  };
  hooks.exportCsv = () => { location.href = '/api/export/drills.csv'; };
  let board: any[] | null = null;
  const loadBoard = () => api('/api/readiness').then((r) => { board = r.operators; app.renderUnit(); }).catch(() => null);
  hooks.operators = () => (board ? board.map((o: any) => ({ n: o.id === s.user.id ? `${o.name} (you)` : o.name, v: o.mastery, me: o.id === s.user.id })) : [{ n: `${s.user.name} (you)`, v: app.R?.after || {}, me: true }]);
  on('finish', () => setTimeout(loadBoard, 600)); loadBoard();
  flushOutbox(chip);
}
