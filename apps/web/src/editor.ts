// Instructor panel: edit doctrine/weapons/pass marks with live validation, build scripted drills, manage users (admin).
// Online: saves to the unit server (versioned). Offline: saves in this browser (add ?instructor to the URL).
import { defaultConfig, getConfig, type Config } from '@parashurama/engine';
import { app, on } from './app';
import { EFF, EFF_ORDER, ORDER, TYPES } from './cfg';
import { $ } from './dom';
import { api } from './online';
import { toast } from './toast';

const LOCAL_CFG = 'parashurama.config', LOCAL_TPL = 'parashurama.templates';
let ctx: { online: boolean; user: any | null; templates: any[] | null };
let draft: Config;
let templates: any[] = [];
const loadLocalTpl = () => { try { return JSON.parse(localStorage.getItem(LOCAL_TPL) || '[]'); } catch { return []; } };
const num = (path: string, v: number, step = 1, min = 0) => `<input type="number" data-path="${path}" value="${v}" step="${step}" min="${min}">`;
const get = (o: any, p: string) => p.split('.').reduce((a, k) => a?.[k], o);
const set = (o: any, p: string, v: any) => { const ks = p.split('.'); const last = ks.pop()!; ks.reduce((a, k) => a[k], o)[last] = v; };
const canAdmin = () => ctx.online && ctx.user?.role === 'admin';

function startTemplate(t: any) {
  const seed = [...t.name].reduce((a: number, ch: string) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  app.startDrill(false, { mode: 'template', template: t.name, cfg: { seed, drill: app.plan.cfg.drill, difficulty: 3, faultSector: 0, focus: { sector: null, loiter: false, decoy: false }, ...t.cfg }, spawns: t.spawns });
}
function renderTemplatesCard() {
  let card = $('#tplCard');
  if (!templates.length) { if (card) card.remove(); return; }
  if (!card) { card = document.createElement('div'); card.id = 'tplCard'; card.className = 'card'; $('#orderCard').before(card); }
  card.innerHTML = `<div class="cardHead"><h3>Instructor drills</h3><span>Set by your instructor · scored</span></div><div class="tplList">${templates.map((t, i) => `<div class="tplItem"><div><b>${t.name}</b><small>${t.cfg.time === 'night' ? 'Night' : 'Day'}, ${t.cfg.terrain}, ${t.cfg.fault === 'none' ? 'sensors healthy' : t.cfg.fault + ' fault'}${t.cfg.weather && t.cfg.weather !== 'clear' ? ', ' + t.cfg.weather : ''} · ${t.spawns.length} contacts</small></div><button class="smallBtn" data-tpl="${i}">Start</button></div>`).join('')}</div>`;
  card.querySelectorAll('[data-tpl]').forEach((b: any) => (b.onclick = () => startTemplate(templates[+b.dataset.tpl])));
}
function weaponsForm() {
  return `<table><tr><th>Weapon</th><th>Reach (m)</th><th>Min (m)</th><th>Delay (s)</th><th>Stock</th><th>Hit chance (0–1)</th></tr>${EFF_ORDER.map((k) => { const e = draft.effectors.effectors[k]; return `<tr><td>${e.label}</td><td>${num(`effectors.effectors.${k}.range`, e.range, 50)}</td><td>${num(`effectors.effectors.${k}.min`, e.min, 50)}</td><td>${num(`effectors.effectors.${k}.delay`, e.delay, 0.5, 0.5)}</td><td>${e.stock != null ? num(`effectors.effectors.${k}.stock`, e.stock) : '∞'}</td><td>${num(`effectors.effectors.${k}.pk`, e.pk ?? 1, 0.05, 0)}</td></tr>`; }).join('')}</table>`;
}
function doctrineForm() {
  const cls = ['rfLinked', 'gnssOnly', 'autonomous'] as const, names = { rfLinked: 'Radio-controlled', gnssOnly: 'GNSS-guided, no radio', autonomous: 'Neither' };
  const m = draft.doctrine.defeat.modifiers;
  return `<table><tr><th>Threat class</th>${EFF_ORDER.map((k) => `<th>${EFF[k].label}</th>`).join('')}</tr>${cls.map((c) => `<tr><td>${names[c]}</td>${EFF_ORDER.map((k) => `<td>${num(`doctrine.defeat.tables.${c}.${k}`, draft.doctrine.defeat.tables[c][k] ?? 0)}</td>`).join('')}</tr>`).join('')}</table>
   <div class="row"><label>Urban gun penalty${num('doctrine.defeat.modifiers.urbanGun', m.urbanGun, 1, -40)}</label><label>Late if under (s)${num('doctrine.defeat.modifiers.lateEngagementSec', m.lateEngagementSec)}</label><label>Late penalty${num('doctrine.defeat.modifiers.late', m.late, 1, -40)}</label><label>Priority penalty${num('doctrine.defeat.modifiers.priority', m.priority, 1, -40)}</label></div>`;
}
function trainingForm() {
  const t = draft.training;
  return `<div class="row"><label>Pass mark (0–100)${num('training.certification.passMark', t.certification.passMark)}</label><label>Certified mastery${num('training.certification.certifiedMastery', t.certification.certifiedMastery, 0.05)}</label><label>Developing mastery${num('training.certification.developingMastery', t.certification.developingMastery, 0.05)}</label></div>
   <div class="row"><label>Friendly check (s)${num('training.clues.friendlyCheckSec', t.clues.friendlyCheckSec, 0.5)}</label><label>RF clue (s)${num('training.clues.rfSec', t.clues.rfSec, 0.5)}</label><label>Behaviour clue (s)${num('training.clues.behaviourSec', t.clues.behaviourSec, 0.5)}</label><label>Drill length (s)${num('training.sim.maxDrillSec', t.sim.maxDrillSec, 10, 30)}</label></div>
   <table><tr><th>Threat</th><th>Speed (m/s)</th><th>Min height (m)</th><th>Max height (m)</th></tr>${ORDER.map((k) => `<tr><td>${TYPES[k].label}</td><td>${num(`threats.threats.${k}.speed`, draft.threats.threats[k].speed, 1, 1)}</td><td>${num(`threats.threats.${k}.alt.0`, draft.threats.threats[k].alt[0])}</td><td>${num(`threats.threats.${k}.alt.1`, draft.threats.threats[k].alt[1])}</td></tr>`).join('')}</table>`;
}
function spawnRow(s: any = { type: ORDER[0], t: 0, brg: 0, dist: 2.9 }) {
  return `<tr><td><select data-f="type">${ORDER.map((k) => `<option value="${k}" ${k === s.type ? 'selected' : ''}>${TYPES[k].short}</option>`).join('')}</select></td><td><input type="number" data-f="t" value="${s.t}" min="0" step="1"></td><td><input type="number" data-f="brg" value="${s.brg}" min="0" max="359" step="5"></td><td><input type="number" data-f="dist" value="${s.dist}" min="0.3" max="3" step="0.1"></td><td><button class="linkBtn" data-del>remove</button></td></tr>`;
}
function templatesForm() {
  return `<div class="tplList" style="padding:0">${templates.map((t, i) => `<div class="tplItem"><div><b>${t.name}</b><small>${t.spawns.length} contacts · ${t.cfg.time}, ${t.cfg.terrain}, ${t.cfg.fault}, ${t.cfg.weather ?? 'clear'}</small></div><button class="linkBtn" data-deltpl="${i}">Delete</button></div>`).join('') || '<p class="note" style="padding:0">No instructor drills yet.</p>'}</div>
   <div class="row"><label>Name<input id="tName" placeholder="Exam 1: night swarm"></label>
   <label>Time<select id="tTime"><option value="day">Day</option><option value="night">Night</option></select></label>
   <label>Terrain<select id="tTer"><option value="rural">Rural</option><option value="urban">Urban</option></select></label>
   <label>Sensor fault<select id="tFault"><option value="none">None</option><option value="radar">Radar</option><option value="eo">Camera</option><option value="rf">RF detector</option></select></label>
   <label>Weather<select id="tWx"><option value="clear">Clear</option><option value="rain">Heavy rain</option><option value="fog">Dense fog</option><option value="dust">Dust storm</option></select></label></div>
   <table id="tSp"><tr><th>Contact</th><th>Enters at (s)</th><th>Bearing (°)</th><th>Distance (km)</th><th></th></tr>${spawnRow()}${spawnRow({ type: 'fpv', t: 10, brg: 90, dist: 2.9 })}</table>
   <div class="edActions"><button id="tAdd">Add contact</button><button class="solid" id="tSave">Save drill</button></div>`;
}
async function usersForm() {
  const u = await api('/api/users').catch(() => ({ users: [] }));
  return `<table><tr><th>Username</th><th>Name</th><th>Role</th><th>Unit</th></tr>${u.users.map((x: any) => `<tr><td>${x.username}</td><td>${x.name}</td><td>${x.role}</td><td>${x.unit}</td></tr>`).join('')}</table>
   <div class="row"><label>Username<input id="uUser"></label><label>Name<input id="uName"></label><label>Role<select id="uRole"><option>trainee</option><option>instructor</option><option>commander</option><option>admin</option></select></label></div>
   <div class="edActions"><button class="solid" id="uAdd">Create user</button><button id="bkBtn">Back up database now</button></div>`;
}
async function open() {
  draft = JSON.parse(JSON.stringify(getConfig()));
  const o = document.createElement('div'); o.className = 'overlay'; o.id = 'editor';
  o.innerHTML = `<div class="sheet" role="dialog" aria-label="Instructor panel"><div class="sheetHead"><h2>Instructor panel</h2><button class="smallBtn" id="edClose">Close</button></div>
    <p class="note" style="padding:0 0 8px">${ctx.online ? 'Changes save to the unit server as a new version and apply to every trainee after they reload.' : 'Offline mode: changes save in this browser only.'} Values are training values, not equipment specifications.</p>
    <div class="edGrid">
      <div class="card"><div class="cardHead"><h3>Weapons</h3><span>reach, delay, stock</span></div><div class="edForm">${weaponsForm()}</div></div>
      <div class="card"><div class="cardHead"><h3>Doctrine points</h3><span>defeat points by threat class</span></div><div class="edForm">${doctrineForm()}</div></div>
      <div class="card"><div class="cardHead"><h3>Training &amp; certification</h3><span>pass marks, clue timing, threats</span></div><div class="edForm">${trainingForm()}</div></div>
      <div class="card"><div class="cardHead"><h3>Scripted drills</h3><span>exams and set scenarios</span></div><div class="edForm" id="tplForm">${templatesForm()}</div></div>
      ${canAdmin() ? `<div class="card" style="grid-column:1/-1"><div class="cardHead"><h3>Users</h3><span>admin only</span></div><div class="edForm" id="usersForm">${await usersForm()}</div></div>` : ''}
    </div>
    <div class="edActions"><button class="solid" id="edSave">Validate and save settings</button><button id="edValidate">Validate only</button><button id="edReset">Reset to defaults</button><span class="edMsg" id="edMsg"></span></div></div>`;
  document.body.appendChild(o);
  o.addEventListener('input', (e: any) => { const p = e.target.dataset.path; if (p) set(draft, p, e.target.value === '' ? 0 : +e.target.value); });
  $('#edClose').onclick = () => o.remove();
  const validate = async () => { const { validateConfig } = await import('./validator'); const r = validateConfig(draft); $('#edMsg').innerHTML = r.ok ? '<b class="good">Valid ✓</b>' : `<b class="bad">Not saved. Fix these:</b><ul>${r.errors.map((x) => `<li>${x}</li>`).join('')}</ul>`; return r.ok; };
  $('#edValidate').onclick = validate;
  const save = async (cfg: Config, note: string) => {
    if (ctx.online) await api('/api/config', { method: 'PUT', body: JSON.stringify({ config: cfg, note }) });
    else localStorage.setItem(LOCAL_CFG, JSON.stringify(cfg));
    $('#edMsg').innerHTML = '<b class="good">Saved ✓</b> <button class="smallBtn" id="edReload">Reload to apply</button>'; $('#edReload').onclick = () => location.reload();
  };
  $('#edSave').onclick = async () => { if (await validate()) await save(draft, 'edited in instructor panel').catch((e) => ($('#edMsg').textContent = 'Save failed: ' + e.message)); };
  $('#edReset').onclick = async () => { if (ctx.online) await save(defaultConfig, 'reset to defaults'); else { localStorage.removeItem(LOCAL_CFG); $('#edMsg').innerHTML = '<b class="good">Defaults restored</b> <button class="smallBtn" id="edReload">Reload</button>'; $('#edReload').onclick = () => location.reload(); } };
  const tf = $('#tplForm');
  tf.addEventListener('click', async (e: any) => {
    if (e.target.dataset.del != null) { e.target.closest('tr').remove(); }
    if (e.target.id === 'tAdd') $('#tSp').insertAdjacentHTML('beforeend', spawnRow());
    if (e.target.dataset.deltpl != null) {
      const t = templates[+e.target.dataset.deltpl];
      if (ctx.online) await api(`/api/templates/${t.id}`, { method: 'DELETE' }); templates.splice(+e.target.dataset.deltpl, 1);
      if (!ctx.online) localStorage.setItem(LOCAL_TPL, JSON.stringify(templates));
      tf.innerHTML = templatesForm(); renderTemplatesCard();
    }
    if (e.target.id === 'tSave') {
      const name = $('#tName').value.trim(); if (!name) { toast('Give the drill a name'); return; }
      const spawns = [...document.querySelectorAll('#tSp tr')].slice(1).map((tr: any) => ({ type: tr.querySelector('[data-f=type]').value, t: +tr.querySelector('[data-f=t]').value, brg: +tr.querySelector('[data-f=brg]').value, dist: Math.round(+tr.querySelector('[data-f=dist]').value * 1000) }));
      if (!spawns.length) { toast('Add at least one contact'); return; }
      const t: any = { name, cfg: { time: $('#tTime').value, terrain: $('#tTer').value, fault: $('#tFault').value, weather: $('#tWx').value, pattern: spawns.some((s) => TYPES[s.type].motion === 'swarm') ? 'swarm' : 'mixed' }, spawns };
      if (ctx.online) { const r = await api('/api/templates', { method: 'POST', body: JSON.stringify(t) }); t.id = r.id; }
      templates.push(t); if (!ctx.online) localStorage.setItem(LOCAL_TPL, JSON.stringify(templates));
      tf.innerHTML = templatesForm(); renderTemplatesCard(); toast(`Saved “${name}”. Trainees see it on their brief.`);
    }
  });
  const uf = $('#usersForm');
  if (uf) uf.addEventListener('click', async (e: any) => {
    if (e.target.id === 'uAdd') {
      try { await api('/api/users', { method: 'POST', body: JSON.stringify({ username: $('#uUser').value.trim(), name: $('#uName').value.trim(), role: $('#uRole').value }) }); uf.innerHTML = await usersForm(); toast('User created'); }
      catch (err: any) { toast(err.body?.error || 'Could not create user'); }
    }
    if (e.target.id === 'bkBtn') { const r = await api('/api/admin/backup', { method: 'POST' }).catch(() => null); toast(r ? `Backup saved: ${r.file}` : 'Backup failed'); }
  });
  void get;
}
export function initEditor(c: { online: boolean; user: any | null; templates: any[] | null }) {
  ctx = c; templates = c.online ? c.templates ?? [] : loadLocalTpl();
  const can = c.online ? ['instructor', 'admin'].includes(c.user?.role) : new URLSearchParams(location.search).has('instructor');
  const b = $('#instrBtn'); b.hidden = !can; b.onclick = open;
  on('brief', renderTemplatesCard);
}
