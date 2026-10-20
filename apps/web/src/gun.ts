// Air-defence gun drills: two games on one engine.
//   Control Room: you are the fire-control officer. You give the orders; an AI detachment crews the gun.
//   On Ground:    you are the gun detachment. Orders come from an AI control room; you load, lay, set the lead and fire.
// Runs at a fixed 10 Hz tick (deterministic, replayable); draws in 2D canvas so it runs on any laptop without a GPU.
import {
  angDiff, controlRoomAI, createGun, dirOf, fly, getConfig, GUN_SKILLS, gunCrewAI, gunDone, gunMastery, gunMaxTicks, gunsOf, gunTti, inSafeArc,
  losOf, muzzleVelocity, observeGun, planGun, runGun, scoreControl, scoreGround, sightSolution, stepGun, targetOnLine, targetPos, engageRange,
  type GunAction, type GunDrillConfig, type GunEngine, type GunGame, type GunRecord, type GunScore, type GunTarget, type OrderKind, type Vec3,
} from '@parashurama/engine';
import { app, hooks } from './app';
import { $ } from './dom';
import { toast } from './toast';

const KEY = 'parashurama.gunH';
const D2R = Math.PI / 180;
let H: GunRecord[] = load();
function load(): GunRecord[] { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(H.slice(-200))); } catch { /* storage full or blocked */ } }
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pad3 = (n: number) => String(Math.round(((n % 360) + 360) % 360)).padStart(3, '0');

interface Radio { t: number; who: 'CR' | 'GUN' | 'SYS'; text: string; }
interface Live {
  game: GunGame; E: GunEngine; log: GunAction[]; q: GunAction[]; acc: number; last: number; raf: number; done: boolean;
  sel: number | null; tracers: Map<number, { t0: number; pts: Vec3[] }>; radio: Radio[]; seenO: number; seenE: number;
  keys: Set<string>; rates: [number, number]; drag: { x: number; y: number; ax: number; ay: number } | null;
  sight: { spd: number; crs: number; rng: number }; sol: any; plan: ReturnType<typeof planGun>;
}
let L: Live | null = null;
let open = false;

// ---------- words of command ----------
const W = () => ({
  rangeClear: 'RANGE CLEAR', alert: 'DETACHMENT, ALERT', target: 'TARGET, bearing {brg}, range {rng}, height {hgt}, {type}', method: 'SHORT BURSTS', engage: 'FIRE',
  hold: 'HOLD FIRE', cease: 'CEASE FIRE', unload: 'UNLOAD, MAKE SAFE', ack: 'ROGER', ready: 'READY', onTarget: 'ON', stoppage: 'STOPPAGE',
  reportSafe: 'GUN CLEAR, {n} ROUNDS EXPENDED', killDestroyed: 'TARGET DESTROYED', killNoEffect: 'NO EFFECT, RE-ENGAGING', ...(gunsOf(getConfig()).orders ?? {}),
} as Record<string, string>);
function orderText(E: GunEngine, o: OrderKind, cid: number | null): string {
  const w = W()[o] ?? o.toUpperCase();
  if (o !== 'target' || cid == null) return w;
  const T = E.targets.find((t) => t.id === cid); if (!T) return w;
  const p = targetPos(T, E.tick * E.dt, E.dt), l = losOf(p);
  return w.replace('{brg}', pad3(l.az)).replace('{rng}', String(Math.round(l.range / 100) * 100)).replace('{hgt}', String(Math.round(p[2] / 10) * 10))
    .replace('{type}', getConfig().threats.threats[T.type].short.toUpperCase());
}
function say(text: string) {
  if ((app.DB.settings?.sound ?? 'sound') !== 'voice' || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text.toLowerCase().replace(/,/g, ', ')); u.rate = 1.1; speechSynthesis.speak(u);
}
function radio(who: Radio['who'], text: string) { if (!L) return; L.radio.push({ t: L.E.tick * L.E.dt, who, text }); if (who !== 'SYS') say(text); }
/** Turn new orders and gun events into radio traffic (both seats see the same net). */
function pumpRadio() {
  const E = L!.E;
  for (; L!.seenO < E.orders.length; L!.seenO++) { const o = E.orders[L!.seenO]; radio('CR', orderText(E, o.o, o.cid)); }
  for (; L!.seenE < E.ev.length; L!.seenE++) {
    const e = E.ev[L!.seenE], w = W();
    if (e.k === 'ack') radio('GUN', w.ack);
    else if (e.k === 'laid' || e.k === 'lock') radio('GUN', w.onTarget);
    else if (e.k === 'loaded') radio('GUN', w.ready);
    else if (e.k === 'stoppage') radio('GUN', w.stoppage);
    else if (e.k === 'killReport') radio('GUN', e.out === 'destroyed' ? w.killDestroyed : w.killNoEffect);
    else if (e.k === 'report') radio('GUN', w.reportSafe.replace('{n}', String(e.n)));
    else if (e.k === 'destroyed') radio('SYS', `Target ${e.cid} destroyed`);
    else if (e.k === 'leaked') radio('SYS', `Target ${e.cid} reached the asset`);
    else if (e.k === 'unauthorisedBurst') radio('SYS', 'Burst fired without clearance');
    else if (e.k === 'safeArcBurst') radio('SYS', 'Burst fired into a safe arc');
    else if (e.k === 'nonHostileInLine') radio('SYS', 'Friendly or civil aircraft near the line of fire');
  }
}

// ---------- lobby ----------
function lobby() {
  const m = gunMastery(H);
  const card = (g: GunGame, title: string, sub: string, body: string) => {
    const p = planGun(H, g), mine = H.filter((h) => h.game === g), last = mine[mine.length - 1];
    const gn = gunsOf(getConfig()).guns[p.cfg.gun]?.short ?? p.cfg.gun;
    return `<button class="gnCard" data-game="${g}"><small>${sub}</small><b>${title}</b><span>${body}</span>
      <span class="gnPlan"><i>Next drill:</i> ${esc(gn)} · ${p.cfg.time} · ${p.cfg.terrain} · WCS ${String(p.cfg.wcs ?? 'tight').toUpperCase()} · ADW ${String(p.cfg.adw ?? 'red').toUpperCase()}${p.cfg.safeArcs ? ' · safe arc' : ''} · level ${p.cfg.difficulty}<br>${esc(p.why)}</span>
      <span class="gnSkills">${GUN_SKILLS.filter((s) => s[2] === g).map(([k, l]) => `<i title="${esc(l)}"><em style="width:${Math.round(m[k] * 100)}%"></em><u>${esc(l)}</u></i>`).join('')}</span>
      <em>${mine.length ? `${mine.length} drills · last ${last.total}` : 'Not tried yet'} · Begin →</em></button>`;
  };
  $('#gunApp').innerHTML = `<div class="gnLobby">
    <div class="gnHead"><h2>Air defence gun drills</h2><button class="smallBtn" id="gnClose">Close</button></div>
    <p class="gnLead">The same engagement from two seats. In the <b>Control Room</b> you give the fire orders. <b>On Ground</b> you are the detachment on a ZU-23-2 or ZSU-23-4: load, lay, set the lead and fire, only on the order.</p>
    <div class="gnCards">
      ${card('control', 'Control Room', 'Fire-control officer', 'Pick the most urgent threat, give Alert → Target → Method → FIRE, respect Weapon Control Status and safe arcs, call Cease and Hold fire, close with Unload.')}
      ${card('ground', 'On Ground', 'Gun detachment', 'Acknowledge, man the gun, load, lay on the indicated target, set speed, course and range on the sight (or lock the radar), fire short bursts on FIRE only, report, unload.')}
    </div>
    <p class="gnNote">Words of command are placeholders until your unit's exact drill wording is loaded (config <code>guns.json</code>). Weapon Control Status and Air Defence Warning use NATO terms. Gun, ammunition and ballistic figures are training values, not equipment specifications.</p>
  </div>`;
  $('#gnClose').onclick = closeGun;
  document.querySelectorAll<HTMLElement>('#gunApp [data-game]').forEach((b) => (b.onclick = () => start(b.dataset.game as GunGame)));
  (document.querySelector('#gunApp [data-game]') as HTMLElement)?.focus();
}

// ---------- drill ----------
export function start(game: GunGame, cfg?: GunDrillConfig) {
  stop();
  const plan = planGun(H, game);
  const c = cfg ?? plan.cfg, E = createGun(c);
  L = { game, E, log: [], q: [], acc: 0, last: performance.now(), raf: 0, done: false, sel: null, tracers: new Map(), radio: [], seenO: 0, seenE: 0,
    keys: new Set(), rates: [0, 0], drag: null, sight: { spd: 20, crs: 0, rng: 1000 }, sol: null, plan };
  const G = E.gun, cfgTxt = `${G.label} · ${c.time === 'night' ? 'Night' : 'Day'} · ${c.terrain} · ${c.met.tempC} °C, ${c.met.pressureHpa} hPa, wind ${Math.round(Math.hypot(c.met.wind[0], c.met.wind[1]))} m/s`;
  const measures = `<b>WCS</b> ${(c.wcs ?? 'tight').toUpperCase()} · <b>ADW</b> ${(c.adw ?? 'red').toUpperCase()}${c.safeArcs?.length ? ` · <b>Safe arc</b> ${c.safeArcs.map(([a, b]) => `${pad3(a)}–${pad3(b)}°`).join(', ')}` : ''}`;
  $('#gunApp').innerHTML = `<div class="gnDrill ${game}">
    <div class="gnBar"><b>${game === 'control' ? 'CONTROL ROOM' : 'ON GROUND'}</b><span>${esc(cfgTxt)}</span><span class="gnMeasures">${measures}</span><span class="gnClock num" id="gnClock">0:00</span><button class="smallBtn" id="gnQuit">End drill</button></div>
    <div class="gnMain"><canvas id="gnView" aria-label="${game === 'control' ? 'Air picture' : 'Gun sight'}"></canvas>${game === 'ground' && G.sight === 'radar' ? '<canvas id="gnScope" aria-label="Fire-control radar"></canvas>' : ''}</div>
    <aside class="gnSide">
      <div class="gnBox" id="gnPanel"></div>
      <div class="gnBox gnRadioBox"><h4>Radio net</h4><div class="gnRadio" id="gnRadio"></div></div>
    </aside></div>`;
  $('#gnQuit').onclick = () => finish(true);
  const view = $('#gnView') as HTMLCanvasElement;
  if (game === 'ground') {
    view.onpointerdown = (e) => { view.setPointerCapture(e.pointerId); L!.drag = { x: e.clientX, y: e.clientY, ax: e.clientX, ay: e.clientY }; };
    view.onpointermove = (e) => { if (L?.drag) { L.drag.x = e.clientX; L.drag.y = e.clientY; } };
    view.onpointerup = () => { if (L) L.drag = null; };
  } else {
    view.onclick = (e) => { const id = pickBlip(e); if (id != null) { L!.sel = id; renderPanel(); } };
  }
  radio('SYS', game === 'control' ? 'You are the fire-control officer. Start with RANGE CLEAR when the range is safe.' : `You are the ${G.short} detachment. Wait for orders; acknowledge with K.`);
  renderPanel();
  L.raf = requestAnimationFrame(loop);
}
function stop() { if (L) cancelAnimationFrame(L.raf); L = null; }
/** Trainee input becomes a time-stamped action on the next tick. */
function act(a: Omit<GunAction, 'tick' | 'seat'>) { if (!L || L.done) return; L.q.push({ ...(a as any), tick: L.E.tick, seat: L.game === 'control' ? 'cr' : 'gun' }); }
function tick() {
  const E = L!.E;
  if (L!.game === 'ground') {
    // Handwheels: keys or mouse drag → slew rates; only changes are logged.
    const k = L!.keys, fine = k.has('shift') ? 0.2 : 1;
    let az = ((k.has('arrowright') || k.has('d')) ? 1 : 0) - ((k.has('arrowleft') || k.has('a')) ? 1 : 0), el = ((k.has('arrowup') || k.has('w')) ? 1 : 0) - ((k.has('arrowdown') || k.has('s')) ? 1 : 0);
    az *= fine; el *= fine;
    if (L!.drag) { az = Math.max(-1, Math.min(1, (L!.drag.x - L!.drag.ax) / 160)); el = Math.max(-1, Math.min(1, -(L!.drag.y - L!.drag.ay) / 160)); }
    if (az !== L!.rates[0] || el !== L!.rates[1]) { L!.rates = [az, el]; act({ k: 'slew', az: +az.toFixed(3), el: +el.toFixed(3) }); }
  }
  const mine = L!.q.map((a) => ({ ...a, tick: E.tick })); L!.q = [];
  const ai = (L!.game === 'control' ? gunCrewAI(E, { ackSec: 1.5 }) : controlRoomAI(E)).map((a) => ({ ...a, tick: E.tick }));
  const acts = [...mine, ...ai];
  L!.log.push(...acts); stepGun(E, acts);
  if (L!.game === 'ground' && E.gun.sight === 'manual') L!.sol = sightSolution(E, L!.sol); else L!.sol = E.fcs;
  pumpRadio();
  if (gunDone(E)) finish(false);
}
function loop(now: number) {
  if (!L || L.done) return;
  L.acc += Math.min(250, now - L.last); L.last = now;
  const step = L.E.dt * 1000;
  let n = 0;
  while (L.acc >= step && n++ < 5 && !L.done) { L.acc -= step; tick(); }
  if (L.done) return;
  draw(); if (L.E.tick % 3 === 0) renderPanel();
  L.raf = requestAnimationFrame(loop);
}

// ---------- side panel ----------
function renderPanel() {
  if (!L) return;
  const E = L.E, g = E.g, G = E.gun;
  ($('#gnClock') as HTMLElement).textContent = `${Math.floor(E.tick * E.dt / 60)}:${String(Math.floor(E.tick * E.dt) % 60).padStart(2, '0')}`;
  const rr = $('#gnRadio') as HTMLElement;
  rr.innerHTML = L.radio.slice(-14).map((r) => `<p class="${r.who}"><i>${Math.floor(r.t / 60)}:${String(Math.floor(r.t) % 60).padStart(2, '0')}</i><b>${r.who}</b>${esc(r.text)}</p>`).join('');
  rr.scrollTop = rr.scrollHeight;
  const status = `<div class="gnStat">
    <span class="${g.posted ? 'ok' : 'warn'}">${g.posted ? 'Manned' : 'Not manned'}</span>
    <span class="${g.loaded ? 'ok' : 'warn'}">${g.busy === 'load' ? 'Loading…' : g.loaded ? `Loaded ${g.ready}` : 'Unloaded'}</span>
    <span class="${g.safety ? 'ok' : 'hot'}">${g.safety ? 'Safety ON' : 'Safety OFF'}</span>
    <span>Reserve ${g.reserve}</span>
    ${g.stoppage ? `<span class="hot">${g.busy === 'clear' ? 'Clearing…' : 'STOPPAGE'}</span>` : ''}
    ${g.busy === 'barrel' ? '<span class="warn">Changing barrel…</span>' : ''}${g.busy === 'post' ? '<span class="warn">Manning…</span>' : ''}${g.busy === 'unload' ? '<span class="warn">Unloading…</span>' : ''}
    <span class="gnHeat"><em style="width:${Math.min(100, Math.round(g.heat / G.heatLimit * 100))}%"></em>Barrel heat</span>
    <span class="${E.held ? 'hot' : E.cleared != null ? 'ok' : ''}">${E.held ? 'HOLD FIRE' : E.cleared != null ? `Cleared: target ${E.cleared}` : 'Not cleared'}</span></div>`;
  if (L.game === 'control') {
    const tracks = E.targets.filter((t) => t.state === 'live').sort((a, b) => gunTti(E, a) - gunTti(E, b));
    if (L.sel != null && !tracks.some((t) => t.id === L!.sel)) L.sel = null;
    const T = getConfig().threats.threats;
    $('#gnPanel').innerHTML = `<h4>Tracks <small>(by time to the asset)</small></h4>
      <table class="gnTracks"><tr><th>#</th><th>Type</th><th>Brg</th><th>Rng</th><th>Hgt</th><th>TTI</th></tr>
      ${tracks.map((t) => { const p = targetPos(t, E.tick * E.dt, E.dt), l = losOf(p), tt = gunTti(E, t), arc = inSafeArc(E.cfg, l.az);
        return `<tr data-cid="${t.id}" class="${t.id === L!.sel ? 'sel' : ''} ${t.hostile ? 'h' : T[t.type].friendly ? 'f' : 'n'}"><td>${t.id}</td><td>${esc(T[t.type].short)}${arc ? ' ⛔' : ''}</td><td>${pad3(l.az)}</td><td>${(l.range / 1000).toFixed(1)}</td><td>${Math.round(p[2])}</td><td>${isFinite(tt) ? Math.round(tt) + ' s' : '—'}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">No tracks</td></tr>'}</table>
      <h4>Orders ${L.sel != null ? `<small>· target ${L.sel}</small>` : '<small>· select a track</small>'}</h4>
      <div class="gnOrders">
        ${([['rangeClear', 'R', 'Range clear'], ['alert', 'A', 'Alert'], ['target', 'T', 'Target'], ['method', 'M', 'Method'], ['engage', 'F', 'FIRE'], ['cease', 'C', 'Cease fire'], ['hold', 'H', 'Hold fire'], ['unload', 'U', 'Unload']] as const)
          .map(([o, k, l]) => `<button class="gnO ${o === 'engage' ? 'fire' : o === 'hold' ? 'hold' : ''}" data-o="${o}" ${((o === 'target' || o === 'engage') && L!.sel == null) ? 'disabled' : ''}>${l}<kbd>${k}</kbd></button>`).join('')}
      </div><h4>Gun</h4>${status}`;
    document.querySelectorAll<HTMLElement>('#gnPanel [data-cid]').forEach((r) => (r.onclick = () => { L!.sel = +r.dataset.cid!; renderPanel(); }));
    document.querySelectorAll<HTMLElement>('#gnPanel [data-o]').forEach((b) => (b.onclick = () => giveOrder(b.dataset.o as OrderKind)));
  } else {
    const des = [...E.orders].reverse().find((o) => o.o === 'target');
    const radar = G.sight === 'radar' && !E.cfg.radarFault;
    $('#gnPanel').innerHTML = `<h4>${esc(G.short)} ${radar ? '· radar fire control' : '· manual sight'}</h4>${status}
      <p class="gnInd">${des ? `Indicated: ${esc(orderText(E, 'target', des.cid))} <small>(at ${Math.round(des.tick * E.dt)} s)</small>` : 'No target indicated yet.'}</p>
      ${radar ? `<p class="gnInd">Radar: ${g.lockCid != null ? `locked on ${g.lockCid}${g.lockStart != null && E.tick - g.lockStart < Math.round((G.radar?.lockSec ?? 0) / E.dt) ? ' (settling…)' : ''}` : 'search'}</p>`
        : `<div class="gnSight"><h4>Sight settings</h4>
        <label>Speed <button data-s="spd:-">−</button><b>${L.sight.spd} m/s</b><button data-s="spd:+">+</button><kbd>[ ]</kbd></label>
        <label>Course <button data-s="crs:-">−</button><b>${L.sight.crs > 0 ? '+' : ''}${L.sight.crs}°</b><button data-s="crs:+">+</button><kbd>; '</kbd></label>
        <label>Range <button data-s="rng:-">−</button><b>${L.sight.rng} m</b><button data-s="rng:+">+</button><kbd>, .</kbd></label>
        <small>Course: 0° = coming straight at you; + = crossing to the right.</small></div>`}
      <div class="gnKeys">
        <button data-g="ack">Acknowledge<kbd>K</kbd></button><button data-g="post">Man gun<kbd>P</kbd></button><button data-g="load">Load<kbd>R</kbd></button>
        <button data-g="safety">Safety<kbd>F</kbd></button>${radar ? '<button data-g="lock">Radar lock<kbd>Q</kbd></button>' : '<button data-g="lay">Lay on target<kbd>L</kbd></button>'}
        <button data-g="clear">Clear stoppage<kbd>C</kbd></button><button data-g="barrel">Change barrel<kbd>B</kbd></button><button data-g="kill">Report kill<kbd>X</kbd></button>
        <button data-g="unload">Unload<kbd>U</kbd></button><button data-g="report">Report rounds<kbd>N</kbd></button>
      </div><p class="gnHelp">Traverse/elevate: arrows or WASD (Shift = fine) or drag on the sight. Fire: hold <kbd>Space</kbd>, short bursts, only on FIRE.</p>`;
    document.querySelectorAll<HTMLElement>('#gnPanel [data-g]').forEach((b) => (b.onclick = () => gunKey(b.dataset.g!)));
    document.querySelectorAll<HTMLElement>('#gnPanel [data-s]').forEach((b) => (b.onclick = () => { const [f, d] = b.dataset.s!.split(':'); nudgeSight(f as any, d === '+' ? 1 : -1); }));
  }
}
function giveOrder(o: OrderKind) {
  if (!L) return;
  if ((o === 'target' || o === 'engage') && L.sel == null) { toast('Select a track first'); return; }
  act({ k: 'order', o, ...(o === 'target' || o === 'engage' ? { cid: L.sel! } : {}) });
}
function nudgeSight(f: 'spd' | 'crs' | 'rng', d: number) {
  if (!L) return;
  const MS = gunsOf(getConfig()).manualSight, s = L.sight;
  if (f === 'spd') s.spd = Math.max(0, s.spd + d * MS.speedStepMs);
  if (f === 'crs') s.crs = Math.max(-180, Math.min(180, s.crs + d * MS.courseStepDeg));
  if (f === 'rng') s.rng = Math.max(100, Math.min(6000, s.rng + d * MS.rangeStepM));
  act({ k: 'sight', ...s }); renderPanel();
}
function gunKey(k: string) {
  if (!L) return;
  const E = L.E, g = E.g;
  const des = [...E.orders].reverse().find((o) => o.o === 'target');
  switch (k) {
    case 'ack': act({ k: 'ack' }); break;
    case 'post': act({ k: 'post' }); break;
    case 'load': act({ k: 'load' }); break;
    case 'safety': act({ k: 'safety', on: !g.safety }); break;
    case 'lay': if (des?.cid != null) act({ k: 'lay', cid: des.cid }); else toast('No target indicated'); break;
    case 'lock': { const T = des?.cid != null ? des.cid : targetOnLine(E, 6)?.id; if (T != null) act({ k: 'lock', cid: T }); else toast('Nothing to lock'); break; }
    case 'clear': act({ k: 'clear' }); break;
    case 'barrel': act({ k: 'barrel' }); break;
    case 'unload': act({ k: 'unload' }); break;
    case 'kill': { const T = E.targets.find((t) => t.state === 'destroyed' && !E.kills.some((x) => x.cid === t.id)) ?? targetOnLine(E, 6);
      if (T) act({ k: 'kill', cid: T.id, out: T.state === 'destroyed' ? 'destroyed' : 'noEffect' }); break; }
    case 'report': { const n = prompt('Rounds expended (issued minus remaining)?', ''); if (n != null && n.trim() !== '' && isFinite(+n)) act({ k: 'report', n: Math.round(+n) }); break; }
  }
}
function pickBlip(e: MouseEvent): number | null {
  const cv = $('#gnView') as HTMLCanvasElement, r = cv.getBoundingClientRect(), E = L!.E;
  const { cx, cy, s } = ppi(cv);
  const x = (e.clientX - r.left) * devicePixelRatio, y = (e.clientY - r.top) * devicePixelRatio;
  let best: number | null = null, bd = 24 * devicePixelRatio;
  for (const T of E.targets) if (T.state === 'live') { const p = targetPos(T, E.tick * E.dt, E.dt), d = Math.hypot(cx + p[0] * s - x, cy - p[1] * s - y); if (d < bd) { bd = d; best = T.id; } }
  return best;
}

// ---------- drawing ----------
function fit(cv: HTMLCanvasElement) { const w = cv.clientWidth * devicePixelRatio, h = cv.clientHeight * devicePixelRatio; if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } return cv.getContext('2d')!; }
const ppi = (cv: HTMLCanvasElement, maxM = 4000) => ({ cx: cv.width / 2, cy: cv.height / 2, s: (Math.min(cv.width, cv.height) / 2 - 12) / maxM });
const COL = { h: '#FF5C61', f: '#5DA9FF', n: '#6FCF97', grid: 'rgba(63,167,150,0.28)', text: '#DCE6EE', dim: '#8A9DAE', arc: 'rgba(255,92,97,0.16)', amber: '#F2C94C' };
function kindCol(T: GunTarget) { const ty = getConfig().threats.threats[T.type]; return T.hostile ? COL.h : ty.friendly ? COL.f : COL.n; }
function draw() {
  if (!L) return;
  if (L.game === 'control') drawPPI($('#gnView') as HTMLCanvasElement, 4000, true);
  else { drawSight(); const sc = $('#gnScope') as HTMLCanvasElement | null; if (sc) drawPPI(sc, 6000, false); }
}
function drawPPI(cv: HTMLCanvasElement, maxM: number, big: boolean) {
  const ctx = fit(cv), E = L!.E, { cx, cy, s } = ppi(cv, maxM), dp = devicePixelRatio;
  ctx.fillStyle = '#0C1218'; ctx.fillRect(0, 0, cv.width, cv.height);
  for (const [a, b] of E.cfg.safeArcs ?? []) {
    ctx.fillStyle = COL.arc; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, maxM * s, (a - 90) * D2R, ((b < a ? b + 360 : b) - 90) * D2R); ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = COL.grid; ctx.lineWidth = dp; ctx.font = `${11 * dp}px Barlow Condensed, sans-serif`; ctx.fillStyle = COL.dim;
  for (let r = 1000; r <= maxM; r += 1000) { ctx.beginPath(); ctx.arc(cx, cy, r * s, 0, 7); ctx.stroke(); ctx.fillText(`${r / 1000} km`, cx + 6 * dp, cy - r * s + 14 * dp); }
  for (let a = 0; a < 360; a += 30) { const v = dirOf(a, 0); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + v[0] * maxM * s, cy - v[1] * maxM * s); ctx.stroke(); if (big) ctx.fillText(pad3(a), cx + v[0] * (maxM * s + 2) - 8 * dp, cy - v[1] * (maxM * s + 2)); }
  ctx.strokeStyle = 'rgba(242,201,76,0.4)'; ctx.setLineDash([4 * dp, 4 * dp]); ctx.beginPath(); ctx.arc(cx, cy, E.gun.effRangeM * s, 0, 7); ctx.stroke(); ctx.setLineDash([]);
  // Gun and its barrel bearing.
  const b = dirOf(E.g.az, 0);
  ctx.strokeStyle = COL.amber; ctx.lineWidth = 2 * dp; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + b[0] * 600 * s * 3, cy - b[1] * 600 * s * 3); ctx.stroke();
  ctx.fillStyle = COL.amber; ctx.fillRect(cx - 4 * dp, cy - 4 * dp, 8 * dp, 8 * dp);
  const T = getConfig().threats.threats;
  for (const t of E.targets) {
    if (t.state !== 'live' && !(t.endTick != null && E.tick - t.endTick < 30)) continue;
    const p = targetPos(t, E.tick * E.dt, E.dt), x = cx + p[0] * s, y = cy - p[1] * s, col = kindCol(t);
    if (!big && L!.game === 'ground' && Math.hypot(p[0], p[1]) > (E.gun.radar?.acquireRangeM ?? 6000)) continue;
    ctx.fillStyle = col; ctx.strokeStyle = col;
    if (t.state === 'live') { ctx.beginPath(); ctx.arc(x, y, (big ? 5 : 3.5) * dp, 0, 7); ctx.fill(); }
    else { ctx.lineWidth = 2 * dp; ctx.beginPath(); ctx.moveTo(x - 5 * dp, y - 5 * dp); ctx.lineTo(x + 5 * dp, y + 5 * dp); ctx.moveTo(x + 5 * dp, y - 5 * dp); ctx.lineTo(x - 5 * dp, y + 5 * dp); ctx.stroke(); }
    if (big && t.state === 'live') {
      const v = [t.v[0], t.v[1]], sp = Math.hypot(v[0], v[1]) || 1; ctx.lineWidth = 1.2 * dp; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + v[0] / sp * 18 * dp, y - v[1] / sp * 18 * dp); ctx.stroke();
      ctx.fillStyle = COL.text; ctx.fillText(`${t.id} ${T[t.type].short} ${Math.round(p[2])} m`, x + 8 * dp, y - 6 * dp);
      if (t.id === L!.sel) { ctx.strokeStyle = COL.amber; ctx.lineWidth = 1.5 * dp; ctx.strokeRect(x - 10 * dp, y - 10 * dp, 20 * dp, 20 * dp); }
    }
    if (!big && E.g.lockCid === t.id) { ctx.strokeStyle = COL.amber; ctx.strokeRect(x - 7 * dp, y - 7 * dp, 14 * dp, 14 * dp); }
  }
  if (!big) { ctx.fillStyle = COL.dim; ctx.fillText('FIRE-CONTROL RADAR', 6 * dp, 14 * dp); }
}
/** Optical sight: what the layer sees. Crosshair = where the sight points; the barrel is offset by the lead. */
function drawSight() {
  const cv = $('#gnView') as HTMLCanvasElement, ctx = fit(cv), E = L!.E, g = E.g, dp = devicePixelRatio, W = cv.width, Hh = cv.height;
  const fov = E.gun.sightFovDeg, pxDeg = W / fov, t = E.tick * E.dt, night = E.cfg.time === 'night';
  const on = targetOnLine(E, fov / 2);
  let offAz = 0, offEl = 0;
  if (L!.sol?.ok && on) { const l = losOf(targetPos(on, t, E.dt)); offAz = angDiff(L!.sol.az, l.az); offEl = L!.sol.el - l.el; }
  const sAz = g.az - offAz, sEl = g.el - offEl;
  const toPx = (az: number, el: number) => [W / 2 + angDiff(az, sAz) * Math.cos(sEl * D2R) * pxDeg, Hh / 2 - (el - sEl) * pxDeg];
  const sky = ctx.createLinearGradient(0, 0, 0, Hh);
  if (night) { sky.addColorStop(0, '#04110A'); sky.addColorStop(1, '#0E2A18'); } else { sky.addColorStop(0, '#7FA9CF'); sky.addColorStop(1, '#D7E4EC'); }
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, Hh);
  // Horizon and terrain silhouette (seeded by azimuth so it does not swim).
  const hy = toPx(sAz, 0)[1];
  if (hy < Hh) {
    ctx.fillStyle = night ? '#06180C' : E.cfg.terrain === 'urban' ? '#6B6F6A' : '#5E6E4A';
    ctx.beginPath(); ctx.moveTo(0, Hh);
    for (let x = 0; x <= W; x += 6 * dp) { const az = sAz + (x - W / 2) / pxDeg, k = Math.floor(az * 4), h = E.cfg.terrain === 'urban' ? ((k * 2654435761) >>> 0) % 7 * 0.08 : Math.sin(az * 0.7) * 0.15 + 0.2; ctx.lineTo(x, hy - h * pxDeg); }
    ctx.lineTo(W, Hh); ctx.fill();
  }
  // Tracers: each round's path sampled once, then drawn as a short streak while the tracer burns.
  const am = E.G.ammo[E.gun.ammo];
  for (const r of E.rounds.slice(-400)) {
    if (L!.tracers.has(r.i)) continue;
    const pts: Vec3[] = []; fly(am, { az: r.az, el: r.el, mv: r.mv }, E.cfg.met, { dt: 0.05, tMax: Math.min(am.tracerSec, r.hit ? r.tau + 0.05 : am.tracerSec) }, (_t, p) => { pts.push([p[0], p[1], p[2]]); });
    L!.tracers.set(r.i, { t0: r.tick * E.dt, pts });
  }
  ctx.lineCap = 'round';
  for (const [i, tr] of L!.tracers) {
    const age = t - tr.t0, k = Math.floor(age / 0.05);
    if (k >= tr.pts.length) { if (age > 6) L!.tracers.delete(i); continue; }
    if (i % 2) continue;
    const a = tr.pts[Math.max(0, k - 2)], b = tr.pts[k], la = losOf(a), lb = losOf(b);
    const [x1, y1] = toPx(la.az, la.el), [x2, y2] = toPx(lb.az, lb.el);
    ctx.strokeStyle = night ? 'rgba(180,255,180,0.9)' : 'rgba(255,120,40,0.95)'; ctx.lineWidth = 2 * dp;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  // Targets.
  const T = getConfig().threats.threats;
  for (const tg of E.targets) {
    const recent = tg.endTick != null && E.tick - tg.endTick < 25;
    if (tg.state !== 'live' && !recent) continue;
    const p = targetPos(tg, t, E.dt), l = losOf(p), [x, y] = toPx(l.az, l.el);
    if (x < -40 || x > W + 40 || y < -40 || y > Hh + 40) continue;
    const span = ({ quad: 0.6, wing: 2.5, bird: 0.8 } as any)[T[tg.type].shape] * (tg.type === 'jetOwa' ? 1.4 : 1);
    const sz = Math.max(3 * dp, (span / l.range) / D2R * pxDeg);
    ctx.fillStyle = night ? '#CFFFD5' : '#20262A';
    if (tg.state === 'destroyed') { ctx.fillStyle = 'rgba(255,170,60,0.85)'; ctx.beginPath(); ctx.arc(x, y, sz * 2 + (E.tick - tg.endTick!) * 0.6 * dp, 0, 7); ctx.fill(); continue; }
    ctx.beginPath(); ctx.ellipse(x, y, sz, Math.max(1.5 * dp, sz * 0.35), 0, 0, 7); ctx.fill();
    ctx.strokeStyle = night ? 'rgba(160,255,170,0.6)' : 'rgba(20,30,30,0.5)'; ctx.lineWidth = dp; ctx.strokeRect(x - 9 * dp, y - 9 * dp, 18 * dp, 18 * dp);
    ctx.fillStyle = night ? '#A8F0B0' : '#1B2A33'; ctx.font = `${11 * dp}px Barlow Condensed, sans-serif`; ctx.fillText(String(tg.id), x + 11 * dp, y - 9 * dp);
  }
  // Reticle.
  const c = night ? 'rgba(170,255,180,0.9)' : 'rgba(10,20,20,0.85)', cx = W / 2, cy = Hh / 2;
  ctx.strokeStyle = c; ctx.lineWidth = 1.4 * dp;
  if (E.gun.sight === 'manual' || E.cfg.radarFault) {
    for (const mil of [10, 20, 30]) { ctx.beginPath(); ctx.arc(cx, cy, mil * 0.0573 * pxDeg, 0, 7); ctx.stroke(); }
  } else {
    const locked = g.lockCid != null && g.lockStart != null && E.tick - g.lockStart >= Math.round((E.gun.radar?.lockSec ?? 0) / E.dt);
    ctx.strokeStyle = locked ? (night ? '#7DFF8A' : '#0B7A3B') : c; ctx.strokeRect(cx - 22 * dp, cy - 16 * dp, 44 * dp, 32 * dp);
    ctx.fillStyle = ctx.strokeStyle; ctx.font = `${12 * dp}px Barlow Condensed, sans-serif`; ctx.fillText(locked ? 'LOCK · FCS SOLUTION' : g.lockCid != null ? 'ACQUIRING' : 'SEARCH', cx - 40 * dp, cy + 34 * dp);
  }
  ctx.beginPath(); ctx.moveTo(cx - 60 * dp, cy); ctx.lineTo(cx - 8 * dp, cy); ctx.moveTo(cx + 8 * dp, cy); ctx.lineTo(cx + 60 * dp, cy); ctx.moveTo(cx, cy - 60 * dp); ctx.lineTo(cx, cy - 8 * dp); ctx.moveTo(cx, cy + 8 * dp); ctx.lineTo(cx, cy + 60 * dp); ctx.stroke();
  ctx.fillStyle = c; ctx.beginPath(); ctx.arc(cx, cy, 1.6 * dp, 0, 7); ctx.fill();
  // Pointer to the indicated target when it is outside the sight.
  const des = [...E.orders].reverse().find((o) => o.o === 'target'), dt = des && E.targets.find((x) => x.id === des.cid && x.state === 'live');
  if (dt) {
    const l = losOf(targetPos(dt, t, E.dt)), [x, y] = toPx(l.az, l.el);
    if (x < 0 || x > W || y < 0 || y > Hh) {
      const a = Math.atan2(y - cy, x - cx), r = Math.min(W, Hh) / 2 - 24 * dp;
      ctx.fillStyle = COL.amber; ctx.save(); ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(12 * dp, 0); ctx.lineTo(-6 * dp, -8 * dp); ctx.lineTo(-6 * dp, 8 * dp); ctx.fill(); ctx.restore();
    }
  }
  // Readouts.
  ctx.fillStyle = night ? '#A8F0B0' : '#0F1A20'; ctx.font = `${13 * dp}px Barlow Condensed, sans-serif`;
  ctx.fillText(`AZ ${g.az.toFixed(1)}°  EL ${g.el.toFixed(1)}°`, 10 * dp, Hh - 12 * dp);
  if (on) ctx.fillText(`On line: ${on.id}${E.gun.sight === 'radar' && !E.cfg.radarFault && g.lockCid === on.id ? ` · radar range ${Math.round(losOf(targetPos(on, t, E.dt)).range)} m` : ''}`, 10 * dp, Hh - 30 * dp);
  if (inSafeArc(E.cfg, g.az)) { ctx.fillStyle = '#FF5C61'; ctx.fillText('SAFE ARC: DO NOT FIRE', W - 170 * dp, 22 * dp); }
  if (!g.safety && g.loaded) { ctx.fillStyle = '#FF5C61'; ctx.fillText('SAFETY OFF', W - 110 * dp, Hh - 12 * dp); }
}

// ---------- debrief ----------
function finish(quit: boolean) {
  if (!L || L.done) return;
  L.done = true; cancelAnimationFrame(L.raf);
  const E = L.E, game = L.game, sc: GunScore = game === 'ground' ? scoreGround(E) : scoreControl(E);
  // Verify: replay the log from the seed; the score must match.
  const R = runGun(E.cfg, { actions: L.log, until: E.tick }), sc2 = game === 'ground' ? scoreGround(R) : scoreControl(R), verified = sc2.total === sc.total;
  // Expert ghost: the doctrine-perfect seat on the same drill.
  const ghost = runGun(E.cfg, { policies: [controlRoomAI, (x) => gunCrewAI(x)], stopWhenDone: true }), gsc = game === 'ground' ? scoreGround(ghost) : scoreControl(ghost);
  const rec: GunRecord & { log?: GunAction[]; verified?: boolean } = { n: H.filter((h) => h.game === game).length + 1, date: Date.now(), game, cfg: E.cfg, total: sc.total, obs: observeGun(sc), metrics: sc.metrics, rules: sc.rules, endTick: E.tick, verified };
  if (!quit || E.tick > 100) { H.push(rec); save(); hooks.syncGunDrill?.({ ...rec, log: L.log }); }
  const pass = sc.total >= getConfig().training.certification.passMark, RULES = getConfig().doctrine.rules;
  const bursts = E.bursts.filter((b) => b.cid != null);
  const maxMiss = 12;
  $('#gunApp').innerHTML = `<div class="gnDebrief">
    <div class="gnHead"><h2>${game === 'control' ? 'Control Room' : 'On Ground'} · debrief</h2><button class="smallBtn" id="gnLobby">All gun drills</button><button class="smallBtn solid" id="gnNext">Next drill →</button></div>
    <div class="gnScore ${pass ? 'pass' : 'fail'}"><b class="num">${sc.total}</b><span>${pass ? 'PASS' : 'NOT YET'} · pass mark ${getConfig().training.certification.passMark}</span>
      <small>${verified ? 'Verified: same score when re-run from the log.' : 'Re-run did not match.'} Expert on the same drill: ${gsc.total}.</small></div>
    <div class="gnMetrics">
      <span><b>${sc.metrics.kills}/${sc.metrics.hostiles}</b>destroyed</span><span><b>${sc.metrics.leaked}</b>reached the asset</span>
      <span><b>${sc.metrics.roundsFired}</b>rounds fired</span><span><b>${sc.metrics.ammoPerKill ?? '—'}</b>rounds per kill</span>
      <span class="${sc.metrics.violations ? 'bad' : ''}"><b>${sc.metrics.violations}</b>fire-discipline violations</span>
    </div>
    <div class="gnCols"><div>
      <h4>Points by rule</h4>
      <table class="gnParts">${sc.parts.map((p) => `<tr><td><span class="rule" title="${esc(RULES[p.rule] ?? '')}">${p.rule}</span></td><td>${esc(p.label)}</td><td class="num">${p.pts}/${p.max}</td><td>${p.why.map(esc).join('<br>')}</td></tr>`).join('')}
      ${sc.deductions.filter((d) => d.pts).map((d) => `<tr class="ded"><td><span class="rule" title="${esc(RULES[d.rule] ?? '')}">${d.rule}</span></td><td>${esc(d.label)}</td><td class="num">${d.pts}</td><td>${d.why.map(esc).join('<br>')}</td></tr>`).join('')}</table>
    </div><div>
      ${game === 'ground' && bursts.length ? `<h4>Burst accuracy <small>(closest pass to the target, m; green = hit)</small></h4>
        <div class="gnBursts">${bursts.map((b) => `<i class="${b.hits ? 'hit' : b.authorised ? '' : 'bad'}" style="height:${Math.max(4, 100 - Math.min(maxMiss, b.bestMiss) / maxMiss * 100)}%" title="Target ${b.cid}: ${isFinite(b.bestMiss) ? b.bestMiss.toFixed(1) + ' m' : 'no pass'}, ${b.rounds} rounds${b.authorised ? '' : ', NOT CLEARED'}"></i>`).join('')}</div>` : ''}
      <h4>Radio net</h4><div class="gnRadio gnLog">${L.radio.map((r) => `<p class="${r.who}"><i>${Math.floor(r.t / 60)}:${String(Math.floor(r.t) % 60).padStart(2, '0')}</i><b>${r.who}</b>${esc(r.text)}</p>`).join('')}</div>
    </div></div></div>`;
  $('#gnLobby').onclick = lobby; $('#gnNext').onclick = () => start(game);
}

// ---------- open / close / keys ----------
export function openGun(game?: GunGame) {
  let el = $('#gunApp') as HTMLElement | null;
  if (!el) { el = document.createElement('div'); el.id = 'gunApp'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Air defence gun drills'); document.body.appendChild(el); }
  el.classList.add('on'); open = true; document.body.classList.add('gunOn');
  if (game) start(game); else lobby();
}
export function closeGun() { stop(); open = false; $('#gunApp')?.classList.remove('on'); document.body.classList.remove('gunOn'); hooks.showHome?.(); }
const ORDER_KEYS: Record<string, OrderKind> = { r: 'rangeClear', a: 'alert', t: 'target', m: 'method', f: 'engage', c: 'cease', h: 'hold', u: 'unload' };
const GUN_KEYS: Record<string, string> = { k: 'ack', p: 'post', r: 'load', f: 'safety', l: 'lay', q: 'lock', c: 'clear', b: 'barrel', x: 'kill', u: 'unload', n: 'report' };
export function initGun() {
  hooks.openGun = openGun;
  document.addEventListener('keydown', (e) => {
    if (!open) return;
    e.stopPropagation();
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'escape') { if (L && !L.done) finish(true); else closeGun(); return; }
    if (!L || L.done) return;
    if (L.game === 'control') { if (ORDER_KEYS[k] && !e.repeat) { e.preventDefault(); giveOrder(ORDER_KEYS[k]); } return; }
    if (k === ' ') { e.preventDefault(); if (!e.repeat) act({ k: 'trig', on: true }); return; }
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'w', 'a', 's', 'd', 'shift'].includes(k)) { e.preventDefault(); L.keys.add(k); return; }
    if (e.repeat) return;
    if (k === '[' || k === ']') nudgeSight('spd', k === ']' ? 1 : -1);
    else if (k === ';' || k === "'") nudgeSight('crs', k === "'" ? 1 : -1);
    else if (k === ',' || k === '.') nudgeSight('rng', k === '.' ? 1 : -1);
    else if (GUN_KEYS[k]) gunKey(GUN_KEYS[k]);
  }, true);
  document.addEventListener('keyup', (e) => {
    if (!open || !L) return;
    const k = e.key.toLowerCase();
    if (k === ' ') act({ k: 'trig', on: false });
    L.keys.delete(k);
  }, true);
  // Test and automation handle: let the AI play the trainee's seat to the end.
  (window as any).PARA_GUN = {
    open: openGun, start, state: () => L && { tick: L.E.tick, done: L.done, game: L.game },
    autoplay: () => { if (!L) return; const E = L.E, me = L.game === 'control' ? controlRoomAI : (x: GunEngine) => gunCrewAI(x);
      while (!L.done && E.tick < gunMaxTicks(E)) { L.q.push(...me(E)); tick(); } if (!L.done) finish(false); },
    history: () => H,
  };
  const q = new URLSearchParams(location.search);
  if (q.has('gun')) openGun((['ground', 'control'] as const).find((g) => q.get('gun') === g));
  void engageRange; void muzzleVelocity; void inSafeArc;
}
