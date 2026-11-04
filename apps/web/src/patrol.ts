// Urban patrol drill: drive a ZSU-23-4 through a built-up area and defend it against drones (packages/engine/src/patrol.ts).
//   W/S throttle, A/D steer (skid steer: it turns on the spot), Shift = crawl. The mouse lays the turret (stabilised, so it
//   holds its bearing while the hull turns). Left button / Space fire, right button the gunner's sight, Q radar lock,
//   E report the contact in the middle, 1–0 identify, / Unknown, Tab next contact, R reload, V camera (chase, commander,
//   driver). Buildings hide drones until they clear the rooftops; rounds that hit buildings count against you.
//   Fixed 10 Hz engine tick (deterministic, replayable); the view interpolates between ticks.
import * as THREE from 'three';
import {
  angDiff, carPose, createPatrol, defaultPatrolCfg, dirOf, fly, getConfig, gunOrigin, losOf, mulberry, pDetectRangeM, patrolDone, patrolMaxTicks, pIdentOf,
  patrolAI, pLocked, pTargetAt, pVisible, PATROL_RULES, scorePatrol, segBlocked, stepPatrol, VEH,
  type PatrolAction, type PatrolCfg, type PatrolEngine, type PatrolScore, type PTarget, type Vec3,
} from '@parashurama/engine';
import { app } from './app';
import { $ } from './dom';
import { toast } from './toast';
import { buildCity, type City } from './city3d';
import { dotTexture, gltf, hdr, hasWebGL } from './field3d';
import { fieldAudio, type FieldAudio } from './fieldaudio';
import { isLite } from './lite';

const KEY = 'parashurama.patrolH';
const D2R = Math.PI / 180;
interface PatrolRecord { n: number; date: number; cfg: PatrolCfg; total: number; rules: string[]; metrics: PatrolScore['metrics']; }
let H: PatrolRecord[] = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } })();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(H.slice(-100))); } catch { /* storage blocked */ } };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pad3 = (n: number) => String(Math.round(((n % 360) + 360) % 360)).padStart(3, '0');
const setHTML = (el: Element | null, html: string) => { if (el && (el as any).__h !== html) { el.innerHTML = html; (el as any).__h = html; } };
/** Engine frame (x east, y north, z up) → three.js (x east, y up, z south). */
const W3 = (p: Vec3, out = new THREE.Vector3()) => out.set(p[0], p[2], -p[1]);
const dirW = (az: number, el: number, out = new THREE.Vector3()) => { const d = dirOf(az, el); return out.set(d[0], d[2], -d[1]); };

type Cam = 'chase' | 'cmdr' | 'driver';
interface Live {
  E: PatrolEngine; log: PatrolAction[]; q: PatrolAction[]; acc: number; last: number; raf: number; done: boolean; onExit: () => void;
  keys: Set<string>; mouseFire: boolean; sent: { thr: number; str: number; az: number; el: number; trig: boolean };
  aim: { az: number; el: number }; cam: Cam; sight: boolean; locked: boolean; sel: number | null; seenEv: number; radio: { t: number; who: string; text: string }[];
  prev: { x: number; y: number; hdg: number; az: number; el: number; T: Map<number, Vec3> }; msg: { text: string; t: number; col: string } | null;
  view: View | null; snd: FieldAudio | null; cleanup: (() => void)[];
}
let L: Live | null = null;

// ---------- start / stop ----------
export function patrolHistory(): PatrolRecord[] { return H; }
/** A patrol drill is open (the gun drills' key handler stands aside). */
export const patrolActive = () => !!L && !L.done;
export async function startPatrol(onExit: () => void, cfg?: PatrolCfg) {
  stopPatrol();
  if (!hasWebGL()) { toast('The urban patrol drill needs WebGL (a 3D-capable browser).'); onExit(); return; }
  const r = mulberry(7211 + H.length * 131), last = H[H.length - 1];
  const diff = Math.max(1, Math.min(5, (last?.cfg.difficulty ?? 2) + (last ? (last.total >= 80 ? 1 : last.total < 60 ? -1 : 0) : 0)));
  const c = cfg ?? defaultPatrolCfg({ seed: 70000 + Math.floor(r() * 1e6), difficulty: diff, time: r() < 0.25 ? 'night' : 'day', weather: r() < 0.7 ? 'clear' : r() < 0.5 ? 'dust' : 'rain', met: { tempC: Math.round(18 + r() * 22), pressureHpa: 1005, wind: [0, 0, 0], latitudeDeg: 26 } });
  $('#gunApp').innerHTML = `<div class="gnDrill field ptDrill">
    <div class="gnBar"><b>URBAN PATROL · ZSU-23-4</b><span id="ptCond"></span><span class="gnMeasures">Drive the route · report · identify · engage only identified hostiles · spare the town</span>
      <span class="gnClock num" id="ptClock">0:00</span><button class="smallBtn" id="ptQuit">End drill</button></div>
    <div class="gnMain" id="ptMain"><div class="ptLoad" id="ptLoad">Loading the town…</div></div>
    <aside class="gnSide"><div class="gnBox" id="ptObj"></div><div class="gnBox" id="ptId"></div><div class="gnBox gnRadioBox"><h4>Radio net</h4><div class="gnRadio" id="ptRadio"></div></div>
      <div class="gnBox"><p class="gnHelp"><kbd>W</kbd><kbd>S</kbd> throttle · <kbd>A</kbd><kbd>D</kbd> steer · <kbd>Shift</kbd> crawl · mouse lays the turret · left click fire · right button gunner's sight · <kbd>Q</kbd> radar lock · <kbd>E</kbd> report contact in the middle · <kbd>1</kbd>–<kbd>0</kbd> identify · <kbd>/</kbd> Unknown · <kbd>Tab</kbd> next contact · <kbd>R</kbd> reload · <kbd>V</kbd> camera · <kbd>Esc</kbd> release the mouse</p>
      <p class="gnNote">Town: a snippet of the PROJECT REALISM city. Vehicle, gun and drone values are training values, not equipment specifications.</p></div></aside></div>`;
  ($('#ptQuit') as HTMLElement).onclick = () => finish(true);
  let E: PatrolEngine;
  try {
    const { loadCityData } = await import('./city3d');
    const data = await loadCityData();
    if (!data) throw new Error('The town data (city/) is not in this build: the urban patrol drill needs the full web build, not the one-file offline copy.');
    E = createPatrol(c, data.meta.world);
  } catch (e: any) { toast(e.message ?? String(e)); onExit(); return; }
  L = { E, log: [], q: [], acc: 0, last: performance.now(), raf: 0, done: false, onExit, keys: new Set(), mouseFire: false, sent: { thr: 0, str: 0, az: 0, el: 0, trig: false },
    aim: { az: E.g.az, el: E.g.el }, cam: 'chase', sight: false, locked: false, sel: null, seenEv: 0, radio: [], prev: { x: E.veh.x, y: E.veh.y, hdg: E.veh.hdg, az: E.g.az, el: E.g.el, T: new Map() }, msg: null,
    view: null, snd: fieldAudio('zsu234'), cleanup: [] };
  const me = L;
  ($('#ptCond') as HTMLElement).textContent = `${c.time} · ${c.weather ?? 'clear'} · level ${c.difficulty} · WCS ${(c.wcs ?? 'tight').toUpperCase()}`;
  radio('SYS', `You command a ZSU-23-4 on patrol through the old town. Drive the route through ${E.cps.length} checkpoint${E.cps.length === 1 ? '' : 's'}. Drones come in low over the rooftops: report each one (E), identify it (1–0), lock (Q) and fire only on hostiles. Do not put rounds into the buildings.`);
  try { me.view = await mountView($('#ptMain') as HTMLElement, E, isLite()); } catch (e: any) { toast(`3D view failed: ${e.message ?? e}`); finish(true); return; }
  if (L !== me) { me.view?.dispose(); return; }
  document.getElementById('ptLoad')?.remove();
  bindKeys(me);
  panel();
  me.last = performance.now(); me.raf = requestAnimationFrame(loop);
}
export function stopPatrol() {
  if (!L) return;
  cancelAnimationFrame(L.raf); L.done = true;
  for (const f of L.cleanup) f();
  L.view?.dispose(); L.snd?.dispose(); L = null;
}

// ---------- input ----------
const act = (a: Omit<PatrolAction, 'tick'>) => { if (L && !L.done) L.q.push({ ...a, tick: L.E.tick } as PatrolAction); };
function bindKeys(me: Live) {
  const order = getConfig().threats.order;
  const down = (e: KeyboardEvent) => {
    if (L !== me || me.done) return;
    const k = e.key.toLowerCase();
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (['w', 'a', 's', 'd', 'shift', ' '].includes(k)) { me.keys.add(k); if (k === ' ') e.preventDefault(); return; }
    if (k === 'tab') { e.preventDefault(); cycle(); return; }
    if (k === 'q') { lockKey(); return; }
    if (k === 'e') { report(); return; }
    if (k === 'r') { act({ k: 'load' }); return; }
    if (k === 'v') { me.cam = me.cam === 'chase' ? 'cmdr' : me.cam === 'cmdr' ? 'driver' : 'chase'; me.msg = { text: me.cam === 'chase' ? 'CHASE VIEW' : me.cam === 'cmdr' ? "COMMANDER'S HATCH" : "DRIVER'S VIEW", t: performance.now(), col: '#fff' }; return; }
    if (/^[0-9]$/.test(k)) { e.preventDefault(); const i = k === '0' ? 9 : +k - 1; if (order[i]) identify(order[i]); return; }
    if (k === '/') { e.preventDefault(); identify('unknown'); }
  };
  const up = (e: KeyboardEvent) => { me.keys.delete(e.key.toLowerCase()); };
  const blur = () => me.keys.clear();
  // Capture phase on window: runs before the gun drills' document handler.
  addEventListener('keydown', down, true); addEventListener('keyup', up, true); addEventListener('blur', blur);
  me.cleanup.push(() => { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); removeEventListener('blur', blur); });
}
function cycle() {
  const E = L!.E, list = E.targets.filter((t) => t.state === 'live' && E.spots[t.id] != null).map((t) => t.id);
  if (!list.length) return;
  L!.sel = list[(list.indexOf(L!.sel ?? -1) + 1) % list.length]; panel();
}
function report() {
  const id = L!.view?.centreTarget(); if (id == null) { toast('No contact in the middle of the view'); return; }
  if (L!.E.spots[id] == null) act({ k: 'spot', cid: id });
  L!.sel = id; setTimeout(panel, 120);
}
function lockKey() {
  const E = L!.E;
  if (E.g.lockCid != null) { act({ k: 'lock' }); return; }
  const id = L!.view?.centreTarget() ?? (L!.sel != null && pVisible(E, E.targets.find((t) => t.id === L!.sel)!) ? L!.sel : null);
  if (id == null) { toast('Nothing to lock: put the contact in the middle of the view'); return; }
  act({ k: 'lock', cid: id });
}
function identify(cls: string) { if (!L || L.sel == null) { toast('Select a contact first (E or Tab)'); return; } act({ k: 'ident', cid: L.sel, cls }); setTimeout(panel, 120); }

// ---------- loop ----------
function tick() {
  const me = L!, E = me.E, k = me.keys, crawl = k.has('shift') ? 0.4 : 1;
  if ((me as any).ai) { me.q.push(...patrolAI(E)); me.aim = { az: E.g.az, el: E.g.el }; me.prev = { x: E.veh.x, y: E.veh.y, hdg: E.veh.hdg, az: E.g.az, el: E.g.el, T: new Map(E.targets.map((t) => [t.id, [...t.p] as Vec3])) }; const acts = me.q.splice(0).map((a) => ({ ...a, tick: E.tick })); me.log.push(...acts); stepPatrol(E, acts); pump(); if (patrolDone(E)) finish(false); return; }
  const thr = ((k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0)) * crawl, str = ((k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0)) * (k.has('shift') ? 0.5 : 1);
  if (thr !== me.sent.thr || str !== me.sent.str) { me.sent.thr = thr; me.sent.str = str; act({ k: 'drive', thr, str }); }
  // The turret follows the mouse aim at its slew rates; on a radar lock the fire control lays it (and the aim follows).
  if (pLocked(E)) { me.aim.az = E.g.az; me.aim.el = E.g.el; if (me.sent.az || me.sent.el) { me.sent.az = me.sent.el = 0; act({ k: 'slew', az: 0, el: 0 }); } }
  else {
    const gun = E.gun, q = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 50) / 50;
    const rz = q(angDiff(me.aim.az, E.g.az) / (gun.slewDegS.az * E.dt)), re = q((me.aim.el - E.g.el) / (gun.slewDegS.el * E.dt));
    if (rz !== me.sent.az || re !== me.sent.el) { me.sent.az = rz; me.sent.el = re; act({ k: 'slew', az: rz, el: re }); }
  }
  const trig = (k.has(' ') || me.mouseFire) && me.cam !== 'driver';
  if (trig !== me.sent.trig) { me.sent.trig = trig; act({ k: 'trig', on: trig }); }
  me.prev = { x: E.veh.x, y: E.veh.y, hdg: E.veh.hdg, az: E.g.az, el: E.g.el, T: new Map(E.targets.map((t) => [t.id, [...t.p] as Vec3])) };
  const acts = me.q.splice(0).map((a) => ({ ...a, tick: E.tick }));
  me.log.push(...acts); stepPatrol(E, acts); pump();
  if (patrolDone(E)) finish(false);
}
function loop(now: number) {
  const me = L; if (!me || me.done) return;
  me.acc += Math.min(250, now - me.last); me.last = now;
  const ms = me.E.dt * 1000;
  let n = 0; while (me.acc >= ms && n++ < 5 && !me.done) { me.acc -= ms; tick(); }
  if (me.done || L !== me) return;
  me.view?.frame(me.E, Math.min(1, me.acc / ms), me);
  if (me.E.tick % 3 === 0) { panel(); ($('#ptClock') as HTMLElement).textContent = clock(me.E); }
  me.raf = requestAnimationFrame(loop);
}
const clock = (E: PatrolEngine) => { const s = Math.max(0, patrolMaxTicks(E) - E.tick) * E.dt; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

// ---------- radio and messages ----------
function radio(who: string, text: string) { if (!L) return; L.radio.push({ t: L.E.tick * L.E.dt, who, text }); }
function pump() {
  const me = L!, E = me.E, T = getConfig().threats.threats, now = performance.now();
  for (; me.seenEv < E.ev.length; me.seenEv++) {
    const e = E.ev[me.seenEv], tg = e.cid != null ? E.targets.find((t) => t.id === e.cid) : undefined, nm = tg ? `contact ${tg.id}` : '';
    const say = (text: string, col = '#fff', who = 'CMDR') => { radio(who, text); me.msg = { text: text.toUpperCase(), t: now, col }; };
    switch (e.k) {
      case 'checkpoint': say(`Checkpoint ${e.n} of ${E.cps.length} reached`, '#9fe0a8', 'SYS'); break;
      case 'collision': if ((e.n ?? 0) > 7) say(`Collision at ${e.n} km/h`, '#F2C94C', 'SYS'); break;
      case 'carHit': say('Hit a civilian vehicle', '#FF5C61', 'SYS'); break;
      case 'vehicleHit': say('We are hit! Drone strike on the patrol', '#FF5C61', 'SYS'); me.view?.hitFlash(); break;
      case 'assetHit': say(`${T[tg!.type].short} struck the defended place`, '#FF5C61', 'SYS'); break;
      case 'observed': say(`${nm}: the enemy observer has fixed the patrol`, '#FF5C61', 'SYS'); break;
      case 'destroyed': say(`${nm} destroyed`, '#9fe0a8'); break;
      case 'lock': radio('CMDR', `Radar on ${nm}`); break;
      case 'lockLost': say(`Lock lost on ${nm}: behind the buildings`, '#F2C94C', 'SYS'); break;
      case 'lockFail': say('Radar cannot lock: no clear line to the contact', '#F2C94C', 'SYS'); break;
      case 'spot': radio('CMDR', `Contact ${e.cid}, bearing ${pad3(losOf([tg!.p[0] - E.veh.x, tg!.p[1] - E.veh.y, tg!.p[2]]).az)}`); break;
      case 'ident': radio('CMDR', `Contact ${e.cid} is ${e.text === 'unknown' ? 'unknown' : T[e.text!]?.short ?? e.text}`); break;
      case 'unclearedBurst': say('Fire only on contacts identified hostile', '#FF5C61', 'SYS'); break;
      case 'empty': say('Out of ready rounds: R to reload', '#F2C94C', 'SYS'); break;
      case 'loading': radio('CREW', 'Reloading'); break;
      case 'loaded': radio('CREW', 'Guns loaded'); break;
    }
  }
}

// ---------- side panel ----------
function panel() {
  const me = L; if (!me) return;
  const E = me.E, T = getConfig().threats.threats, order = getConfig().threats.order, o = gunOrigin(E);
  const H2 = E.targets.filter((t) => t.hostile), kills = H2.filter((t) => t.state === 'destroyed').length;
  setHTML($('#ptObj'), `<h4>Mission</h4><ul class="ptObj">
    <li class="${E.cpDone.length === E.cps.length ? 'ok' : ''}">Patrol route: ${E.cpDone.length}/${E.cps.length} checkpoints</li>
    <li>Hostiles destroyed: ${kills}${H2.length ? `/${H2.length} so far` : ''}</li>
    <li class="${E.veh.hits ? 'bad' : ''}">Patrol struck: ${E.veh.hits}</li>
    <li>Rounds into buildings: ${E.rounds.filter((r) => r.bt != null && r.bp && r.bp[2] > 0.5).length}</li></ul>`);
  const spotted = E.targets.filter((t) => t.state === 'live' && E.spots[t.id] != null);
  if (me.sel != null && !E.targets.some((t) => t.id === me.sel && t.state === 'live')) me.sel = null;
  const S = me.sel != null ? E.targets.find((t) => t.id === me.sel) : undefined;
  let clue = '';
  if (S) {
    const l = losOf([S.p[0] - o[0], S.p[1] - o[1], S.p[2] - o[2]]), spd = Math.hypot(S.v[0], S.v[1]), ty = T[S.type], id = pIdentOf(E, S.id);
    clue = `<div class="gnClue"><b>Contact ${S.id}</b> · bearing ${pad3(l.az)}° · range ${Math.round(l.range)} m · height about ${Math.round(S.p[2] / 5) * 5} m · speed about ${Math.round(spd / 5) * 5} m/s
      ${ty.acoustic && l.range <= ty.acoustic.rangeM ? `<br>Sound: ${esc(ty.acoustic.sig)}` : ''}${pVisible(E, S) ? '' : '<br><i>Out of sight behind the buildings</i>'}</div>
      <div class="gnIdKeys">${order.map((k, i) => `<button data-id="${k}" class="${id === k ? 'on' : ''} ${T[k].hostile ? 'h' : T[k].friendly ? 'f' : 'n'}">${esc(T[k].short)}${i < 10 ? `<kbd>${(i + 1) % 10}</kbd>` : ''}</button>`).join('')}<button data-id="unknown" class="${id === 'unknown' ? 'on' : ''}">Unknown<kbd>/</kbd></button></div>`;
  }
  const el = $('#ptId') as HTMLElement;
  setHTML(el, `<h4>Contacts <small>E reports the one in the middle · Tab cycles</small></h4><div class="gnContacts">${spotted.map((t) => { const id = pIdentOf(E, t.id); return `<button data-sel="${t.id}" class="${t.id === me.sel ? 'sel' : ''}">${t.id} · ${id ? (id === 'unknown' ? 'unknown' : esc(T[id]?.short ?? id)) : '<i>not identified</i>'}${E.g.lockCid === t.id ? ' · LOCK' : ''}</button>`; }).join('') || '<span class="gnNote">No contacts reported. Watch the rooftops and listen.</span>'}</div>${clue}`);
  el.querySelectorAll<HTMLElement>('[data-sel]').forEach((b) => (b.onclick = () => { me.sel = +b.dataset.sel!; panel(); }));
  el.querySelectorAll<HTMLElement>('[data-id]').forEach((b) => (b.onclick = () => identify(b.dataset.id!)));
  setHTML($('#ptRadio'), me.radio.slice(-14).reverse().map((r) => `<p><span class="num">${Math.floor(r.t / 60)}:${String(Math.floor(r.t % 60)).padStart(2, '0')}</span> <b>${esc(r.who)}</b> ${esc(r.text)}</p>`).join(''));
}

// Test and automation handle: state, the engine, and the expert commander playing to the end.
(window as any).PARA_PATROL = {
  start: (cfg?: Partial<PatrolCfg>) => startPatrol(() => undefined, cfg ? defaultPatrolCfg(cfg) : undefined),
  state: () => L && { tick: L.E.tick, done: L.done, veh: L.E.veh, cps: `${L.E.cpDone.length}/${L.E.cps.length}`, cam: L.cam },
  engine: () => L?.E,
  cam: (c: Cam, aim?: { az: number; el: number }) => { if (L) { L.cam = c; if (aim) L.aim = { ...aim }; } },
  drive: (thr: number, str: number) => { if (L) { L.keys.clear(); if (thr > 0) L.keys.add('w'); if (thr < 0) L.keys.add('s'); if (str > 0) L.keys.add('d'); if (str < 0) L.keys.add('a'); } },
  ai: (on: boolean) => { if (L) (L as any).ai = on; },
};

// ---------- end and debrief ----------
function finish(quit: boolean) {
  const me = L; if (!me || me.done) return;
  const E = me.E, sc = scorePatrol(E), onExit = me.onExit;
  me.done = true; cancelAnimationFrame(me.raf);
  if (!quit || E.tick > 300) { H.push({ n: H.length + 1, date: Date.now(), cfg: E.cfg, total: sc.total, rules: sc.rules, metrics: sc.metrics }); save(); }
  stopPatrol();
  const pass = sc.total >= getConfig().training.certification.passMark, m = sc.metrics;
  $('#gunApp').innerHTML = `<div class="gnDebrief"><div class="gnHead"><h2>Urban patrol · debrief</h2><button class="smallBtn" id="ptBack">All drills</button><button class="smallBtn solid" id="ptAgain">Next patrol →</button></div>
    <p class="gnLead"><b class="${pass ? 'ok' : 'bad'}" style="font-size:42px">${sc.total}</b> / 100 · ${pass ? 'PASS' : 'NOT YET'} (pass mark ${getConfig().training.certification.passMark})${quit ? ' · ended early' : ''}</p>
    <div class="gnCols"><div><h4>Per contact (average)</h4><table class="gnTracks">${sc.parts.map((p) => `<tr><td>${p.rule}</td><td>${esc(p.label)}</td><td class="num">${p.pts} / ${p.max}</td></tr>`).join('')}
      ${sc.deductions.map((d) => `<tr><td>${d.rule}</td><td>${esc(d.label)}</td><td class="num bad">${d.pts}</td></tr>`).join('')}</table>
      <h4>Measured</h4><p class="gnNote">${m.kills}/${m.hostiles} hostiles destroyed · ${m.leaked} got through · ${m.roundsFired} rounds, ${m.hits} hits · ${m.buildingRounds} rounds into buildings · checkpoints ${m.checkpoints} · ${m.distanceM} m driven · ${m.collisions} collisions, ${m.carHits} civilian vehicles hit · struck ${m.vehicleHits}×</p></div>
    <div><h4>Why</h4><ul class="gnWhy">${sc.why.map((w) => `<li>${esc(w)}</li>`).join('') || '<li>A clean patrol.</li>'}</ul>
      <h4>Rules</h4><ul class="gnWhy">${Object.entries(PATROL_RULES).map(([k, v]) => `<li class="${sc.rules.includes(k) ? 'bad' : ''}"><b>${k}</b> ${esc(v)}</li>`).join('')}</ul></div></div>
    <p class="gnNote">Simulated scores are training measures, not operational effectiveness. ${H.length} patrol drill${H.length === 1 ? '' : 's'} on this computer; the next one is set from your last score.</p></div>`;
  ($('#ptBack') as HTMLElement).onclick = onExit;
  ($('#ptAgain') as HTMLElement).onclick = () => void startPatrol(onExit);
}

// ---------- the 3D view ----------
interface View { frame: (E: PatrolEngine, f: number, me: Live) => void; centreTarget: () => number | null; hitFlash: () => void; dispose: () => void; }
async function mountView(host: HTMLElement, E0: PatrolEngine, lite: boolean): Promise<View> {
  const cfg = E0.cfg, night = cfg.time === 'night', wx = cfg.weather ?? 'clear';
  const renderer = new THREE.WebGLRenderer({ antialias: !lite, powerPreference: 'high-performance' });
  renderer.setPixelRatio(lite ? 0.8 : Math.min(1.5, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = night ? 0.95 : 0.8;
  renderer.shadowMap.enabled = !lite; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const cv = renderer.domElement; cv.className = 'fdGl';
  const hud = document.createElement('canvas'); hud.className = 'fdHud';
  const tip = document.createElement('div'); tip.className = 'fdTip';
  tip.innerHTML = '<b>Click to take command</b><span>W/S throttle · A/D steer · mouse lays the turret · left click fire · right button sight · Q lock · E report · V camera · Esc releases the mouse</span>';
  host.append(cv, hud, tip);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(65, 1, 0.1, 9000);
  const sky = await hdr(night ? 'night' : wx === 'clear' ? 'day' : wx === 'rain' ? 'overcast' : wx);
  const pmrem = new THREE.PMREMGenerator(renderer);
  if (sky) { scene.background = sky; scene.environment = pmrem.fromEquirectangular(sky).texture; scene.backgroundIntensity = night ? 0.6 : 1; }
  else { scene.background = new THREE.Color(night ? 0x060a12 : 0x9fb6c8); scene.add(new THREE.HemisphereLight(0xdfe9f2, 0x5b5a48, night ? 0.2 : 0.9)); }
  const sunDir = new THREE.Vector3(-0.5, night ? 0.5 : 0.75, -0.35).normalize();
  const sun = new THREE.DirectionalLight(night ? 0x7f93b8 : 0xfff0d8, night ? 0.3 : wx === 'clear' ? 2.8 : 1.0);
  sun.castShadow = !lite; sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 400 }); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  const hazeCol = new THREE.Color(night ? 0x0a0f18 : wx === 'dust' ? 0xb19a78 : wx === 'clear' ? 0xc4cfd6 : 0x9aa3a8);
  scene.fog = new THREE.Fog(hazeCol, wx === 'clear' ? 250 : 120, wx === 'clear' ? 2600 : wx === 'dust' ? 900 : 1400);
  const city: City | null = await buildCity(scene, lite, !lite);
  const heightAt = (x: number, z: number) => city?.heightAt(x, z) ?? 0;

  // ---------- the vehicle ----------
  const src = await gltf('models/zsu234.glb');
  const veh = src ? src.clone(true) : (() => { const g = new THREE.Group(); const b = new THREE.Mesh(new THREE.BoxGeometry(3.1, 1.6, 6.5), new THREE.MeshStandardMaterial({ color: 0x3b4429 })); b.position.y = 1.1; g.add(b); const y = new THREE.Group(); y.name = 'yaw'; y.position.y = 1.9; g.add(y); const p = new THREE.Group(); p.name = 'pitch'; p.position.set(0, 0.2, -1); y.add(p); return g; })();
  veh.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  scene.add(veh);
  const yaw = veh.getObjectByName('yaw') ?? veh, pitch = veh.getObjectByName('pitch') ?? yaw, yaw0 = yaw.quaternion.clone(), pitch0 = pitch.quaternion.clone();
  const radarN = veh.getObjectByName('radar'), eyeN = veh.getObjectByName('eye'), sightN = veh.getObjectByName('sight_eye'), drvN = veh.getObjectByName('driver_eye');
  const muzzles: THREE.Object3D[] = []; veh.traverse((c) => { if (/^muzzle\d/.test(c.name)) muzzles.push(c); });
  const wheels: THREE.Object3D[] = []; veh.traverse((c) => { if (/^wheel_[lr]\d/.test(c.name)) wheels.push(c); });
  const tracks: { m: THREE.MeshStandardMaterial; side: number }[] = [];
  veh.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh && /^track_[lr]/.test((m.parent?.name.startsWith('track') ? m.parent.name : m.name))) { const mat = (m.material as THREE.MeshStandardMaterial).clone(); if (mat.map) { mat.map = mat.map.clone(); mat.map.wrapS = mat.map.wrapT = THREE.RepeatWrapping; mat.map.needsUpdate = true; } m.material = mat; tracks.push({ m: mat, side: /_l/.test(m.name + m.parent?.name) ? -1 : 1 }); } });
  const head = new THREE.SpotLight(0xfff2d0, night ? 60 : 0, 90, 0.5, 0.6, 1.5); head.position.set(0, 1.4, -3.2); head.target.position.set(0, 0, -30); veh.add(head, head.target);

  // ---------- drones, cars, effects ----------
  const droneLib = await gltf('models/drones.glb'), dot = dotTexture();
  // Detailed models where they exist (tools/blender/import_drones.py); otherwise the built-in shapes.
  const better: Record<string, THREE.Group | null> = { fpv: await gltf('models/drone_fpv.glb'), swarm: await gltf('models/drone_swarm.glb'), male: await gltf('models/drone_male.glb') };
  interface Vis { g: THREE.Object3D; props: THREE.Object3D[]; speck: THREE.Sprite; fall?: { t0: number; p: THREE.Vector3; v: THREE.Vector3 } }
  const vis = new Map<number, Vis>();
  const droneOf = (type: string): THREE.Object3D => {
    const s = better[type]?.getObjectByName(`drone_${type}`) ?? droneLib?.getObjectByName(`drone_${type}`) ?? droneLib?.getObjectByName('drone_fpv');
    if (s) { const c = s.clone(true); c.position.set(0, 0, 0); return c; }
    return new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.15, 0.4), new THREE.MeshStandardMaterial({ color: 0x333333 }));
  };
  const carLib = await Promise.all(['sedan', 'pickup'].map((k) => gltf(`city/vehicles/${k}.glb`)));
  const cars = E0.cars.map((_, i) => { const s = carLib[i % 2] ?? carLib[0]; const o = s ? s.clone(true) : new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 4.5), new THREE.MeshStandardMaterial({ color: 0x8a8070 })); o.traverse((c) => { (c as THREE.Mesh).castShadow = true; }); scene.add(o); return o; });
  const fx = new THREE.Group(); scene.add(fx);
  const MAXT = 700, tpos = new Float32Array(MAXT * 6), tgeo = new THREE.BufferGeometry(); tgeo.setAttribute('position', new THREE.BufferAttribute(tpos, 3));
  const tracerLines = new THREE.LineSegments(tgeo, new THREE.LineBasicMaterial({ color: night ? 0xffe2a0 : 0xffa848, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  tracerLines.frustumCulled = false; fx.add(tracerLines);
  const tracers = new Map<number, { t0: number; pts: THREE.Vector3[]; end: number; bp: Vec3 | null }>();
  const puffs: { s: THREE.Sprite; t0: number; life: number; grow: number; kind: 'smoke' | 'flash' | 'dust' }[] = [];
  const puff = (at: THREE.Vector3, t: number, kind: 'smoke' | 'flash' | 'dust', size: number, life: number, col = 0x2d2d2d) => {
    if (puffs.length > 350) { const o = puffs.shift()!; fx.remove(o.s); o.s.material.dispose(); }
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: kind === 'flash' ? 0xffd27a : col, transparent: true, depthWrite: false, fog: kind !== 'flash', blending: kind === 'flash' ? THREE.AdditiveBlending : THREE.NormalBlending }));
    s.position.copy(at); s.scale.setScalar(size); fx.add(s); puffs.push({ s, t0: t, life, grow: size, kind });
  };
  const flashes = muzzles.map((m) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: 0xffc56a, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true })); s.visible = false; m.add(s); return s; });
  const flashLight = new THREE.PointLight(0xffb060, 0, 25, 2); pitch.add(flashLight); if (muzzles[0]) flashLight.position.copy(muzzles[0].position);
  let precip: THREE.Object3D | null = null;
  if (!lite && (wx === 'rain' || wx === 'dust')) {
    const n = wx === 'rain' ? 3000 : 1500, p = new Float32Array(n * (wx === 'rain' ? 6 : 3)); let s = 7;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) { const x = (r() - 0.5) * 70, y = r() * 30, z = (r() - 0.5) * 70; if (wx === 'rain') p.set([x, y, z, x + 0.04, y - 0.7, z], i * 6); else p.set([x, y, z], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    precip = wx === 'rain' ? new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xb4bec8, transparent: true, opacity: 0.3, fog: false })) : new THREE.Points(g, new THREE.PointsMaterial({ color: 0xb59c72, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.5 }));
    precip.frustumCulled = false; scene.add(precip);
  }

  // ---------- input ----------
  let locked = false, sight = false, hitT = -1e9;
  const onLock = () => { locked = document.pointerLockElement === cv; tip.style.display = locked ? 'none' : ''; if (!locked && L) { L.mouseFire = false; sight = false; } };
  document.addEventListener('pointerlockchange', onLock);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('mousedown', (e) => {
    if (!locked) { if (e.button === 0) void cv.requestPointerLock(); return; }
    if (e.button === 0 && L) L.mouseFire = true; if (e.button === 2) sight = true; if (e.button === 1) { e.preventDefault(); report(); }
  });
  const mup = (e: MouseEvent) => { if (e.button === 0 && L) L.mouseFire = false; if (e.button === 2) sight = false; };
  addEventListener('mouseup', mup);
  let look = { az: 0, el: 0 };
  cv.addEventListener('mousemove', (e) => {
    if (!locked || !L) return;
    const k = camera.fov / Math.max(1, host.clientHeight) * 0.9;
    if (L.cam === 'driver') { look.az = Math.max(-100, Math.min(100, look.az + e.movementX * k)); look.el = Math.max(-30, Math.min(40, look.el - e.movementY * k)); return; }
    L.aim.az = (L.aim.az + e.movementX * k + 360) % 360; L.aim.el = Math.max(L.E.gun.elevDeg[0], Math.min(L.E.gun.elevDeg[1], L.aim.el - e.movementY * k));
  });
  const ro = new ResizeObserver(() => { const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); hud.width = w * devicePixelRatio; hud.height = h * devicePixelRatio; });
  ro.observe(host);
  const project = (p: THREE.Vector3) => { const v = p.clone().project(camera); return { x: (v.x + 1) / 2 * host.clientWidth, y: (1 - v.y) / 2 * host.clientHeight, front: v.z < 1 && v.z > -1 }; };
  let lastE = E0, lastF = 0;
  const posOf = (T: PTarget) => { const pr = L?.prev.T.get(T.id); return pr ? ([pr[0] + (T.p[0] - pr[0]) * lastF, pr[1] + (T.p[1] - pr[1]) * lastF, pr[2] + (T.p[2] - pr[2]) * lastF] as Vec3) : pTargetAt(T, lastF); };
  /** Where the aim points on the screen (the middle, except in the chase view). */
  const aimScreen = () => {
    if (!L || L.cam !== 'chase' || sight) return { x: host.clientWidth / 2, y: host.clientHeight / 2 };
    const o = gunOrigin(lastE), d = dirOf(L.aim.az, L.aim.el), s = project(W3([o[0] + d[0] * 800, o[1] + d[1] * 800, o[2] + d[2] * 800]));
    return s.front ? s : { x: host.clientWidth / 2, y: host.clientHeight / 2 };
  };
  const centreTarget = () => {
    let best: number | null = null, bd = 70; const c0 = aimScreen();
    for (const T of lastE.targets) { if (!pVisible(lastE, T)) continue; const s = project(W3(posOf(T))); if (!s.front) continue; const d = Math.hypot(s.x - c0.x, s.y - c0.y); if (d < bd) { bd = d; best = T.id; } }
    return best;
  };

  // ---------- per frame ----------
  let firedSeen = 0, evSeen = 0, wasFiring = false, kick = 0, trackOff = [0, 0];
  const hctx = hud.getContext('2d')!, am = E0.am, tmp = new THREE.Vector3();
  const vehPose = (E: PatrolEngine, f: number, me: Live) => {
    const x = me.prev.x + (E.veh.x - me.prev.x) * f, y = me.prev.y + (E.veh.y - me.prev.y) * f, hdg = me.prev.hdg + angDiff(E.veh.hdg, me.prev.hdg) * f;
    return { x, y, hdg, az: me.prev.az + angDiff(E.g.az, me.prev.az) * f, el: me.prev.el + (E.g.el - me.prev.el) * f };
  };
  function frame(E: PatrolEngine, f: number, me: Live) {
    const now = performance.now(), t = (E.tick - 1 + f) * E.dt;
    lastE = E; lastF = f;
    const P = vehPose(E, f, me), a = P.hdg * D2R, fx = Math.sin(a), fy = Math.cos(a);
    // Hull on the ground: height and tilt from the terrain under the tracks.
    const hf = heightAt(P.x + fx * 3, -(P.y + fy * 3)), hb = heightAt(P.x - fx * 3, -(P.y - fy * 3)), hl = heightAt(P.x - fy * 1.4, -(P.y + fx * 1.4)), hr = heightAt(P.x + fy * 1.4, -(P.y - fx * 1.4));
    veh.position.set(P.x, (hf + hb + hl + hr) / 4, -P.y);
    veh.rotation.set(0, 0, 0); veh.rotateY(-P.hdg * D2R); veh.rotateX(Math.atan2(hf - hb, 6) - (E.veh.thr - E.veh.v / VEH.vMax) * 0.01); veh.rotateZ(Math.atan2(hl - hr, 2.8));
    yaw.quaternion.copy(yaw0).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angDiff(P.az, P.hdg) * D2R));
    pitch.quaternion.copy(pitch0).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), P.el * D2R));
    if (radarN) radarN.rotation.y = pLocked(E) ? 0 : Math.sin(now * 0.0025) * 0.9;
    // Wheels and tracks turn with the ground speed (each side with its share of the turn).
    const turn = E.veh.str * VEH.turnDegS * D2R * (E.veh.v !== 0 || E.veh.str !== 0 ? 1 : 0);
    const sideV = [E.veh.v - turn * VEH.halfW, E.veh.v + turn * VEH.halfW];
    for (const w of wheels) w.rotateX(-(sideV[/_l/.test(w.name) ? 0 : 1] * (1 / 60)) / 0.35);
    for (const tr of tracks) { const i = tr.side < 0 ? 0 : 1; trackOff[i] += sideV[i] / 60 * 0.15; if (tr.m.map) tr.m.map.offset.x = trackOff[i]; }
    if (Math.abs(E.veh.v) > 3 && Math.random() < 0.25) puff(tmp.set(P.x - fx * 3.4 + (Math.random() - 0.5) * 2, 0.4, -(P.y - fy * 3.4)).clone(), t, 'dust', 2.5, 2.2, 0x9a8a70);
    me.snd?.engine(Math.min(1, Math.abs(E.veh.v) / VEH.vMax * 0.8 + Math.abs(E.veh.thr) * 0.2));
    // Civilian cars.
    E.cars.forEach((c, i) => { const p = carPose(E, c, c.s + (c.waiting ? 0 : c.speed * E.dt * (f - 1))); cars[i].position.set(p.x, heightAt(p.x, -p.y), -p.y); cars[i].rotation.set(0, -p.h + Math.PI, 0); });
    syncTargets(E, t, now); syncFire(E, t, me);
    placeCamera(E, P, me);
    // Specks a constant ~4 px whatever the zoom; drones you could see at this range show as a dot.
    const sk = (2 * Math.tan((camera.fov * D2R) / 2) * 5) / Math.max(1, host.clientHeight);
    for (const v of vis.values()) v.speck.scale.setScalar(sk);
    const o = gunOrigin(E);
    me.snd?.hear(E.targets.map((tg) => ({ id: tg.id, type: tg.type, p: tg.state === 'live' ? [tg.p[0] - o[0], tg.p[1] - o[1], tg.p[2] - o[2]] as Vec3 : null })), me.aim.az, me.aim.el);
    sun.target.position.set(P.x, 0, -P.y); sun.position.copy(sunDir).multiplyScalar(150).add(sun.target.position);
    if (precip) precip.position.set(camera.position.x, camera.position.y - 8 - ((now / (wx === 'rain' ? 35 : 500)) % 10), camera.position.z);
    renderer.render(scene, camera);
    drawHud(E, P, t, me, now);
  }
  function syncTargets(E: PatrolEngine, t: number, now: number) {
    for (const T of E.targets) {
      let v = vis.get(T.id);
      if (!v) {
        const g = droneOf(T.type), props: THREE.Object3D[] = []; g.traverse((o) => { if (/^prop/.test(o.name)) props.push(o); });
        const speck = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: night ? 0x9aa2ab : 0x101010, fog: false, depthWrite: false, sizeAttenuation: false, transparent: true }));
        v = { g, props, speck }; vis.set(T.id, v); scene.add(g, speck);
      }
      if (T.state === 'destroyed' && T.endTick != null) {
        if (!v.fall) { const p = W3(T.p); v.fall = { t0: T.endTick * E.dt, p, v: new THREE.Vector3(T.v[0] * 0.3, 2, -T.v[1] * 0.3) }; puff(p, t, 'flash', 6, 0.35); puff(p.clone(), t, 'smoke', 5, 5, 0x2a2622); }
        const s = t - v.fall.t0, y = v.fall.p.y + v.fall.v.y * s - 4.9 * s * s, gy = heightAt(v.fall.p.x, v.fall.p.z);
        v.g.visible = s < 20; v.speck.visible = false;
        v.g.position.set(v.fall.p.x + v.fall.v.x * Math.min(s, 3), Math.max(gy + 0.1, y), v.fall.p.z + v.fall.v.z * Math.min(s, 3));
        if (y > gy) { v.g.rotation.x += 0.12; v.g.rotation.z += 0.08; if (Math.random() < 0.3) puff(v.g.position.clone(), t, 'smoke', 1.5, 2, 0x222222); }
        continue;
      }
      if (T.state !== 'live') { if (T.state === 'leaked' && v.g.visible) { puff(W3(T.p), t, 'flash', 9, 0.5); puff(W3(T.p), t, 'smoke', 8, 6, 0x262320); } v.g.visible = v.speck.visible = false; continue; }
      const p = posOf(T); W3(p, v.g.position); v.speck.position.copy(v.g.position);
      v.g.rotation.set(0, -Math.atan2(T.v[0], T.v[1]) + Math.PI, Math.sin(now * 0.002 + T.id) * 0.05);
      const R = pDetectRangeM(E, T), d = Math.hypot(p[0] - E.veh.x, p[1] - E.veh.y, p[2] - 3), a = Math.max(0, Math.min(1, (1.12 * R - d) / (0.12 * R)));
      v.g.visible = true; v.speck.visible = a > 0; v.speck.material.opacity = a * 0.9;
      for (const r of v.props) r.rotateY(1.9);
    }
  }
  function syncFire(E: PatrolEngine, t: number, me: Live) {
    if (E.rounds.length > firedSeen) { me.snd?.rounds(E.rounds.length - firedSeen, E.dt); kick = 1; }
    for (; firedSeen < E.rounds.length; firedSeen++) {
      const r = E.rounds[firedSeen]; if (r.i % 2) continue;
      const end = Math.min(am.tracerSec, r.hit ? r.tau + 0.02 : r.bt ?? am.tracerSec), pts: THREE.Vector3[] = [];
      fly(am, { az: r.az, el: r.el, mv: r.mv }, E.cfg.met, { dt: 0.05, tMax: end + 0.05 }, (_t, p) => { pts.push(W3([r.o[0] + p[0], r.o[1] + p[1], r.o[2] + p[2]])); });
      tracers.set(r.i, { t0: r.tick * E.dt, pts, end, bp: r.bp });
    }
    for (; evSeen < E.ev.length; evSeen++) { const e = E.ev[evSeen]; if (e.k === 'destroyed') { const T = E.targets.find((x) => x.id === e.cid); if (T) me.snd?.boom(Math.hypot(T.p[0] - E.veh.x, T.p[1] - E.veh.y), true); } if (e.k === 'loading') me.snd?.loader('start'); if (e.k === 'loaded') me.snd?.loader('done'); }
    let n = 0;
    for (const [i, tr] of tracers) {
      const age = t - tr.t0, k = age / 0.05;
      if (age < 0) continue;
      if (age >= tr.end || k >= tr.pts.length - 1) {
        // Round into a building or the ground: a spurt of dust and plaster (the collateral the drill counts).
        if (tr.bp && tr.end < am.tracerSec) { const at = W3(tr.bp); puff(at, t, 'flash', 1.2, 0.1); puff(at.clone(), t, 'dust', 1.6, 1.8, 0xb8ab94); }
        tracers.delete(i); continue;
      }
      if (n >= MAXT) continue;
      const k0 = Math.floor(k), fr = k - k0, a = tr.pts[k0], b = tr.pts[k0 + 1], h = a.clone().lerp(b, fr), tl = tr.pts[Math.max(0, k0 - 1)].clone().lerp(a, fr);
      tpos.set([tl.x, tl.y, tl.z, h.x, h.y, h.z], n * 6); n++;
    }
    tgeo.setDrawRange(0, n * 2); (tgeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i], a = (t - p.t0) / p.life;
      if (a >= 1 || a < -0.5) { fx.remove(p.s); p.s.material.dispose(); puffs.splice(i, 1); continue; }
      p.s.material.opacity = p.kind === 'flash' ? 1 - a : (p.kind === 'dust' ? 0.55 : 0.7) * (1 - a);
      p.s.scale.setScalar(p.grow * (p.kind === 'flash' ? 1 + a : 1 + a * 2.5)); if (p.kind !== 'flash') p.s.position.y += p.kind === 'dust' ? 0.004 : 0.012;
    }
    const firing = E.g.trig && E.g.ready > 0 && E.g.busyUntil == null;
    if (wasFiring && !firing) me.snd?.burstEnd();
    wasFiring = firing;
    flashes.forEach((s) => { s.visible = firing && Math.random() < 0.75; s.scale.setScalar(0.8 * (0.7 + Math.random() * 0.6)); });
    flashLight.intensity = firing ? (night ? 40 : 15) * Math.random() : 0;
    if (firing && Math.random() < 0.3 && muzzles[0]) puff(muzzles[0].getWorldPosition(new THREE.Vector3()), t, 'smoke', 1.0, 1.6, 0x8a8a84);
    kick *= 0.8;
  }
  function placeCamera(E: PatrolEngine, P: { x: number; y: number; hdg: number; az: number; el: number }, me: Live) {
    const fwd = new THREE.Vector3(), base = veh.position;
    const sightView = sight && me.cam !== 'driver';
    if (sightView) {
      (sightN ?? pitch).getWorldPosition(camera.position); camera.fov = 9; dirW(P.az, P.el, fwd);
    } else if (me.cam === 'driver') {
      (drvN ?? veh).getWorldPosition(camera.position); camera.fov = 72; dirW(P.hdg + look.az, look.el - 4, fwd);
    } else if (me.cam === 'cmdr') {
      (eyeN ?? yaw).getWorldPosition(camera.position); camera.fov = 70; dirW(me.aim.az + (Math.random() - 0.5) * kick * 0.1, me.aim.el, fwd);
    } else {
      // Chase: behind and above the line of the aim, pulled in when a building is in the way.
      camera.fov = 62;
      const back = dirW(me.aim.az, 0, new THREE.Vector3()).multiplyScalar(-13), want = base.clone().add(back).add(new THREE.Vector3(0, 5.2 + Math.max(0, me.aim.el) * 0.06, 0));
      const from: Vec3 = [base.x, -base.z, 3.5], to: Vec3 = [want.x, -want.z, want.y], hit = segBlocked(E, from, to);
      camera.position.copy(hit == null ? want : base.clone().add(new THREE.Vector3(0, 3.5, 0)).lerp(want, Math.max(0.15, hit - 0.08)));
      // The camera takes part of the elevation (the vehicle stays in the picture); the aim mark shows the true aim.
      dirW(me.aim.az, Math.min(me.aim.el * 0.55, 30), fwd);
      const tgt = base.clone().add(new THREE.Vector3(0, 2.6, 0)).add(fwd.clone().multiplyScalar(40));
      camera.up.set(0, 1, 0); camera.lookAt(tgt); camera.updateProjectionMatrix();
      veh.visible = true; return;
    }
    camera.up.set(0, 1, 0); camera.lookAt(camera.position.clone().add(fwd)); camera.updateProjectionMatrix();
    veh.visible = !sightView;
  }
  function drawHud(E: PatrolEngine, P: { x: number; y: number; hdg: number; az: number; el: number }, t: number, me: Live, now: number) {
    const c = hctx, w = hud.width, h = hud.height, dp = devicePixelRatio, cx = w / 2, cy = h / 2, T = getConfig().threats.threats;
    c.clearRect(0, 0, w, h); c.font = `600 ${14 * dp}px Barlow Condensed, sans-serif`; c.lineWidth = 1.4 * dp;
    const sightView = sight && me.cam !== 'driver';
    // Brackets on reported contacts; the radar lock box.
    for (const tg of E.targets) {
      if (tg.state !== 'live' || E.spots[tg.id] == null) continue;
      const s = project(W3(posOf(tg))); if (!s.front || s.x < 0 || s.y < 0 || s.x > host.clientWidth || s.y > host.clientHeight) continue;
      const id = pIdentOf(E, tg.id), col = !id || id === 'unknown' ? '#F2C94C' : T[id]?.hostile ? '#FF5C61' : T[id]?.friendly ? '#5DA9FF' : '#6FCF97';
      const x = s.x * dp, y = s.y * dp, b = (tg.id === me.sel ? 15 : 11) * dp;
      c.strokeStyle = col; c.lineWidth = (tg.id === me.sel ? 2 : 1.3) * dp;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { c.beginPath(); c.moveTo(x + sx * b, y + sy * b * 0.45); c.lineTo(x + sx * b, y + sy * b); c.lineTo(x + sx * b * 0.45, y + sy * b); c.stroke(); }
      const rng = Math.round(Math.hypot(tg.p[0] - E.veh.x, tg.p[1] - E.veh.y, tg.p[2] - 2));
      c.fillStyle = col; c.fillText(`${tg.id}${id ? ' ' + (id === 'unknown' ? '?' : T[id]?.short ?? id) : ''} ${rng} m${pVisible(E, tg) ? '' : ' (hidden)'}`, x + b + 3 * dp, y - b + 10 * dp);
      if (E.g.lockCid === tg.id) { c.strokeStyle = pLocked(E) ? '#22d36a' : '#F2C94C'; c.lineWidth = 2 * dp; c.strokeRect(x - 22 * dp, y - 22 * dp, 44 * dp, 44 * dp); c.fillStyle = c.strokeStyle; c.fillText(pLocked(E) ? 'LOCK' : 'ACQ…', x - 22 * dp, y + 36 * dp); }
    }
    // Aim and gun line; the fire-control lead mark on a lock.
    if (me.cam !== 'driver') {
      c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 1.4 * dp;
      if (sightView) {
        c.strokeStyle = night ? 'rgba(150,255,170,0.9)' : 'rgba(255,60,40,0.9)';
        c.beginPath(); c.moveTo(cx - 120 * dp, cy); c.lineTo(cx - 12 * dp, cy); c.moveTo(cx + 12 * dp, cy); c.lineTo(cx + 120 * dp, cy); c.moveTo(cx, cy + 12 * dp); c.lineTo(cx, cy + 90 * dp); c.stroke();
        for (const r of [40, 80]) { c.beginPath(); c.arc(cx, cy, r * dp, 0, 7); c.stroke(); }
        c.save(); c.fillStyle = 'rgba(0,0,0,0.9)'; c.fillRect(0, 0, w, h); c.globalCompositeOperation = 'destination-out'; c.beginPath(); c.arc(cx, cy, Math.min(w, h) * 0.46, 0, 7); c.fill(); c.restore();
      } else { const am2 = aimScreen(); c.beginPath(); c.arc(am2.x * dp, am2.y * dp, 2.6 * dp, 0, 7); c.fillStyle = 'rgba(255,255,255,0.95)'; c.fill(); c.beginPath(); c.arc(am2.x * dp, am2.y * dp, 14 * dp, 0, 7); c.strokeStyle = 'rgba(255,255,255,0.5)'; c.stroke(); }
      const o = gunOrigin(E), g = project(W3([o[0] + dirOf(P.az, P.el)[0] * 1500, o[1] + dirOf(P.az, P.el)[1] * 1500, o[2] + dirOf(P.az, P.el)[2] * 1500]));
      if (g.front && !sightView) { c.strokeStyle = 'rgba(242,201,76,0.9)'; c.beginPath(); c.arc(g.x * dp, g.y * dp, 9 * dp, 0, 7); c.stroke(); }
    }
    // Compass tape: aim bearing, the next checkpoint, and drones you can hear (sound gives a bearing, nothing more).
    const az = me.cam === 'driver' ? P.hdg + look.az : sightView ? P.az : me.aim.az, pxDeg = 4 * dp;
    c.fillStyle = 'rgba(0,0,0,0.4)'; c.fillRect(cx - 200 * dp, 8 * dp, 400 * dp, 24 * dp); c.fillStyle = 'rgba(255,255,255,0.9)'; c.font = `600 ${13 * dp}px Barlow Condensed, sans-serif`;
    for (let a = Math.ceil((az - 50) / 5) * 5; a <= az + 50; a += 5) { const x = cx + angDiff(a, az) * pxDeg; if (Math.abs(x - cx) > 196 * dp) continue; c.fillRect(x, 24 * dp, dp, (a % 10 ? 4 : 8) * dp); if (a % 30 === 0) c.fillText(a % 360 === 0 ? 'N' : a % 360 === 90 ? 'E' : a % 360 === 180 ? 'S' : a % 360 === 270 ? 'W' : pad3(a), x - 8 * dp, 21 * dp); }
    c.fillText(`${pad3(az)}°${me.cam !== 'driver' ? `  EL ${me.aim.el.toFixed(0)}°` : ''}`, cx - 30 * dp, 48 * dp);
    const mark = (brg: number, col: string, label: string, tri = true) => {
      const d = angDiff(brg, az), x = Math.abs(d) <= 48 ? cx + d * pxDeg : cx + Math.sign(d) * 196 * dp;
      c.fillStyle = col; if (tri) { c.beginPath(); c.moveTo(x, 34 * dp); c.lineTo(x - 5 * dp, 42 * dp); c.lineTo(x + 5 * dp, 42 * dp); c.fill(); } else c.fillRect(x - 2 * dp, 32 * dp, 4 * dp, 10 * dp);
      if (Math.abs(d) > 48 || label) c.fillText(label || `${d > 0 ? '▶' : '◀'}`, x + (d > 0 ? -34 : 4) * dp, 58 * dp);
    };
    const nx = E.cps.find((k) => !E.cpDone.includes(k));
    if (nx != null) { const p = E.route[nx], d = Math.hypot(p[0] - E.veh.x, p[1] - E.veh.y); mark((Math.atan2(p[0] - E.veh.x, p[1] - E.veh.y) / D2R + 360) % 360, '#9fe0a8', `CP ${E.cpDone.length + 1} ${Math.round(d)} m`, false); }
    for (const tg of E.targets) {
      if (tg.state !== 'live' || tg.type === 'bird') continue;
      const ac = T[tg.type].acoustic, rel: Vec3 = [tg.p[0] - E.veh.x, tg.p[1] - E.veh.y, tg.p[2]];
      if (ac && Math.hypot(...rel) < ac.rangeM && !pVisible(E, tg)) mark(Math.round(losOf(rel).az / 10) * 10, 'rgba(242,201,76,0.8)', '♪');
    }
    // Minimap (north up): buildings, route, checkpoints, patrol, turret line, radar contacts (green) and reported ones.
    drawMap(c, E, P, me, 16 * dp, h - 236 * dp, 220 * dp, dp);
    // Vehicle and gun state, bottom right.
    c.font = `600 ${15 * dp}px Barlow Condensed, sans-serif`;
    const kmh = Math.round(Math.abs(E.veh.v) * 3.6), gear = E.veh.v > 0.3 ? 'F' : E.veh.v < -0.3 ? 'R' : 'N';
    const lines: [string, string][] = [
      [`${kmh} km/h  ${gear}   HULL ${pad3(P.hdg)}°  TURRET ${angDiff(P.az, P.hdg) >= 0 ? '+' : ''}${Math.round(angDiff(P.az, P.hdg))}°`, '#ffffff'],
      [`ZSU-23-4  ·  ${E.g.busyUntil != null ? 'RELOADING…' : E.g.ready > 0 ? `${E.g.ready} READY` : 'EMPTY · R: RELOAD'}  /  ${E.g.reserve}`, E.g.ready > 0 && E.g.busyUntil == null ? '#ffffff' : '#F2C94C'],
      [E.g.lockCid != null ? (pLocked(E) ? `RADAR LOCK · CONTACT ${E.g.lockCid}${E.fcs?.ok ? ' · SOLUTION' : ''}` : `ACQUIRING CONTACT ${E.g.lockCid}…`) : 'RADAR SEARCH · Q TO LOCK', E.g.lockCid != null && pLocked(E) ? '#22d36a' : '#9fe0a8'],
    ];
    if (E.g.trig && E.g.lockCid != null && !pIdentOf(E, E.g.lockCid)) lines.push(['NOT IDENTIFIED: DO NOT FIRE', '#FF5C61']);
    lines.forEach(([s, col], i) => { c.fillStyle = 'rgba(0,0,0,0.45)'; const tw = c.measureText(s).width; c.fillRect(w - tw - 26 * dp, h - (36 + i * 24) * dp, tw + 14 * dp, 21 * dp); c.fillStyle = col; c.fillText(s, w - tw - 19 * dp, h - (20 + i * 24) * dp); });
    const heat = Math.min(1, E.g.heat / E.gun.heatLimit); c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(w - 146 * dp, h - (40 + lines.length * 24) * dp, 120 * dp, 8 * dp);
    c.fillStyle = heat > 0.9 ? '#FF5C61' : heat > 0.6 ? '#F2C94C' : '#9fe0a8'; c.fillRect(w - 146 * dp, h - (40 + lines.length * 24) * dp, 120 * dp * heat, 8 * dp);
    // Messages and the strike flash.
    if (me.msg && now - me.msg.t < 2600) { c.font = `700 ${22 * dp}px Barlow Condensed, sans-serif`; c.globalAlpha = Math.min(1, (2600 - (now - me.msg.t)) / 500); c.fillStyle = me.msg.col; const tw = c.measureText(me.msg.text).width; c.fillText(me.msg.text, cx - tw / 2, 96 * dp); c.globalAlpha = 1; }
    if (now - hitT < 900) { c.fillStyle = `rgba(255,60,40,${0.35 * (1 - (now - hitT) / 900)})`; c.fillRect(0, 0, w, h); }
    void t;
  }
  // Pre-drawn building map for the minimap.
  const W = E0.W, mapC = document.createElement('canvas'), MS = 512; mapC.width = mapC.height = MS;
  { const m = mapC.getContext('2d')!, k = MS / (2 * W.half + 40), ox = W.centre[0] - W.half - 20, oy = W.centre[1] + W.half + 20;
    m.fillStyle = 'rgba(20,26,22,0.85)'; m.fillRect(0, 0, MS, MS);
    m.fillStyle = 'rgba(70,74,68,0.9)'; for (const r of W.roads) { const hw = r[4] / 2; m.fillRect((Math.min(r[0], r[2]) - hw - ox) * k, (oy - Math.max(r[1], r[3]) - hw) * k, (Math.abs(r[2] - r[0]) + 2 * hw) * k, (Math.abs(r[3] - r[1]) + 2 * hw) * k); }
    m.fillStyle = 'rgba(190,178,150,0.85)'; for (const b of W.boxes) m.fillRect((b[0] - ox) * k, (oy - b[3]) * k, (b[2] - b[0]) * k, (b[3] - b[1]) * k);
    m.fillStyle = 'rgba(255,255,255,0.7)'; m.font = '12px Barlow Condensed, sans-serif'; for (const l of W.landmarks) m.fillText(l.name, (l.x - ox) * k - 20, (oy - l.y) * k); }
  function drawMap(c: CanvasRenderingContext2D, E: PatrolEngine, P: { x: number; y: number; hdg: number; az: number }, me: Live, x0: number, y0: number, S: number, dp: number) {
    const k = S / (2 * W.half + 40), ox = W.centre[0] - W.half - 20, oy = W.centre[1] + W.half + 20, X = (x: number) => x0 + (x - ox) * k, Y = (y: number) => y0 + (oy - y) * k;
    c.drawImage(mapC, x0, y0, S, S); c.strokeStyle = 'rgba(255,255,255,0.3)'; c.strokeRect(x0, y0, S, S);
    c.save(); c.beginPath(); c.rect(x0, y0, S, S); c.clip();
    c.strokeStyle = 'rgba(159,224,168,0.6)'; c.lineWidth = 2 * dp; c.setLineDash([4 * dp, 3 * dp]); c.beginPath(); E.route.forEach((p, i) => (i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1])))); c.stroke(); c.setLineDash([]);
    E.cps.forEach((k2, i) => { const p = E.route[k2], done = E.cpDone.includes(k2); c.fillStyle = done ? '#9fe0a8' : '#ffffff'; c.beginPath(); c.arc(X(p[0]), Y(p[1]), 5 * dp, 0, 7); c.fill(); c.fillStyle = '#06100c'; c.font = `700 ${9 * dp}px Barlow Condensed, sans-serif`; c.fillText(String(i + 1), X(p[0]) - 2.5 * dp, Y(p[1]) + 3 * dp); });
    for (const car of E.cars) { const p = carPose(E, car); c.fillStyle = '#8fb3d9'; c.fillRect(X(p.x) - 2 * dp, Y(p.y) - 2 * dp, 4 * dp, 4 * dp); }
    const T = getConfig().threats.threats;
    for (const tg of E.targets) {
      if (tg.state !== 'live') continue;
      const rep = E.spots[tg.id] != null, visNow = pVisible(E, tg); if (!rep && !visNow) continue;
      const id = pIdentOf(E, tg.id), col = !rep ? '#7dff9a' : !id || id === 'unknown' ? '#F2C94C' : T[id]?.hostile ? '#FF5C61' : T[id]?.friendly ? '#5DA9FF' : '#6FCF97';
      const mx = Math.max(x0 + 4, Math.min(x0 + S - 4, X(tg.p[0]))), my = Math.max(y0 + 4, Math.min(y0 + S - 4, Y(tg.p[1])));
      c.fillStyle = col; c.fillRect(mx - 3 * dp, my - 3 * dp, 6 * dp, 6 * dp); if (rep) { c.font = `600 ${10 * dp}px Barlow Condensed, sans-serif`; c.fillText(String(tg.id), mx + 5 * dp, my - 3 * dp); }
    }
    const vx = X(P.x), vy = Y(P.y), a = P.hdg * D2R, ta = P.az * D2R;
    c.strokeStyle = '#F2C94C'; c.lineWidth = 1.5 * dp; c.beginPath(); c.moveTo(vx, vy); c.lineTo(vx + Math.sin(ta) * 40 * dp, vy - Math.cos(ta) * 40 * dp); c.stroke();
    c.fillStyle = '#ffffff'; c.beginPath(); c.moveTo(vx + Math.sin(a) * 8 * dp, vy - Math.cos(a) * 8 * dp); c.lineTo(vx + Math.sin(a + 2.5) * 6 * dp, vy - Math.cos(a + 2.5) * 6 * dp); c.lineTo(vx + Math.sin(a - 2.5) * 6 * dp, vy - Math.cos(a - 2.5) * 6 * dp); c.fill();
    c.restore();
    void me;
  }
  return {
    frame, centreTarget, hitFlash: () => { hitT = performance.now(); },
    dispose: () => {
      document.removeEventListener('pointerlockchange', onLock); removeEventListener('mouseup', mup);
      if (document.pointerLockElement === cv) document.exitPointerLock();
      ro.disconnect(); city?.dispose(); renderer.dispose(); renderer.forceContextLoss(); pmrem.dispose(); cv.remove(); hud.remove(); tip.remove();
    },
  };
}
