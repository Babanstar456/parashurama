// Igla (MANPADS) drill on foot (packages/engine/src/igla.ts): first person in the urban patrol's town.
//   W/A/S/D walk, Shift run, mouse look. Hold the right button to shoulder the launcher and look through the clip-on
//   sight (T: day channel / thermal). F switches on the battery-coolant unit (seeker ready in 5 s, spent 35 s later).
//   Put the target in the ring: a pulsing tone while the seeker acquires, a steady tone and the green light on lock.
//   Lift the launcher a few degrees above and ahead of the target (the marks below and beside the ring), left click to
//   fire. R moves the gripstock to a fresh tube, B screws on a fresh BCU. E selects the contact in the middle, 1–0
//   identify it, / Unknown, Tab next contact. Fixed 10 Hz engine tick (deterministic, replayable); the view interpolates.
import * as THREE from 'three';
import {
  angDiff, createIgla, defaultIglaCfg, dirOf, getConfig, iBcuLeft, iEye, iglaAI, iglaDone, iglaMaxTicks, iIdentOf, iLaunchClear, iTargetAt, iVisible, IGLA, IGLA_RULES,
  losOf, mulberry, scoreIgla, stepIgla,
  type IglaAction, type IglaCfg, type IglaEngine, type IglaScore, type ITarget, type Vec3,
} from '@parashurama/engine';
import { app } from './app';
import { $ } from './dom';
import { toast } from './toast';
import { buildCity, type City } from './city3d';
import { dotTexture, gltf, hdr, hasWebGL } from './field3d';
import { fieldAudio, type FieldAudio } from './fieldaudio';
import { isLite } from './lite';

const KEY = 'parashurama.iglaH';
const D2R = Math.PI / 180;
export interface IglaRecord { n: number; date: number; cfg: IglaCfg; total: number; rules: string[]; metrics: IglaScore['metrics']; }
let H: IglaRecord[] = (() => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(H.slice(-100))); } catch { /* storage blocked */ } };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pad3 = (n: number) => String(Math.round(((n % 360) + 360) % 360) % 360).padStart(3, '0');
const setHTML = (el: Element | null, html: string) => { if (el && (el as any).__h !== html) { el.innerHTML = html; (el as any).__h = html; } };
/** Engine frame (x east, y north, z up) → three.js (x east, y up, z south). */
const W3 = (p: Vec3, out = new THREE.Vector3()) => out.set(p[0], p[2], -p[1]);
const rel = (E: IglaEngine, p: Vec3): Vec3 => { const e = iEye(E); return [p[0] - e[0], p[1] - e[1], p[2] - e[2]]; };
/** Field of view (deg) by eye and through the clip-on sight (about 3× magnification). */
const FOV_EYE = 70, FOV_SIGHT = 23;

interface Live {
  E: IglaEngine; log: IglaAction[]; q: IglaAction[]; acc: number; last: number; raf: number; done: boolean; onExit: () => void;
  keys: Set<string>; rmb: boolean; sent: { f: number; s: number; run: boolean; raise: boolean; az: number; el: number };
  look: { az: number; el: number }; sway: { az: number; el: number }; sel: number | null; seenEv: number; radio: { t: number; who: string; text: string }[];
  prev: { x: number; y: number; T: Map<number, Vec3>; M: Map<number, Vec3> }; msg: { text: string; t: number; col: string } | null;
  channel: 'day' | 'ti'; netCalls: Map<number, { t: number; brg: number; near?: boolean }>; ai: boolean;
  view: View | null; snd: FieldAudio | null; tone: IglaSound | null; cleanup: (() => void)[];
}
let L: Live | null = null;

// ---------- start / stop ----------
export function iglaHistory(): IglaRecord[] { return H; }
/** An Igla drill is open (the gun drills' key handler stands aside). */
export const iglaActive = () => !!L && !L.done;
export async function startIgla(onExit: () => void, cfg?: IglaCfg) {
  stopIgla();
  if (!hasWebGL()) { toast('The Igla drill needs WebGL (a 3D-capable browser).'); onExit(); return; }
  const r = mulberry(9311 + H.length * 137), last = H[H.length - 1];
  const diff = Math.max(1, Math.min(5, (last?.cfg.difficulty ?? 1) + (last ? (last.total >= 80 ? 1 : last.total < 60 ? -1 : 0) : 0)));
  // The first drill: day, clear sky, level 1. Then night and weather come in.
  const c = cfg ?? defaultIglaCfg({ seed: 50000 + Math.floor(r() * 1e6), difficulty: diff, time: H.length && r() < 0.3 ? 'night' : 'day', weather: !H.length || r() < 0.7 ? 'clear' : r() < 0.5 ? 'dust' : 'rain' });
  $('#gunApp').innerHTML = `<div class="gnDrill field ptDrill igDrill">
    <div class="gnBar"><b>IGLA · MANPADS ON FOOT</b><span id="igCond"></span><span class="gnMeasures">Find open sky · identify · a missile only for a target worth one · take cover from FPVs</span>
      <span class="gnClock num" id="igClock">0:00</span><button class="smallBtn" id="igQuit">End drill</button></div>
    <div class="gnMain" id="igMain"><div class="ptLoad" id="igLoad">Loading the town…</div></div>
    <aside class="gnSide"><div class="gnBox" id="igObj"></div><div class="gnBox" id="igId"></div><div class="gnBox gnRadioBox"><h4>Radio · air defence net</h4><div class="gnRadio" id="igRadio"></div></div>
      <div class="gnBox"><p class="gnHelp"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk · <kbd>Shift</kbd> run · mouse look · <b>hold right button</b> shoulder and sight · <kbd>T</kbd> day / thermal · <kbd>F</kbd> switch on the BCU · <b>left click</b> fire (only on lock) · <kbd>R</kbd> fresh tube · <kbd>B</kbd> fresh BCU · <kbd>E</kbd> select the contact in the middle · <kbd>1</kbd>–<kbd>0</kbd> identify · <kbd>/</kbd> Unknown · <kbd>Tab</kbd> next contact · <kbd>Esc</kbd> release the mouse</p>
      <p class="gnNote">Igla (9K38-type) in outline: the words, timings and ranges are training values, not equipment specifications. Town: a snippet of the PROJECT REALISM city.</p></div></aside></div>`;
  ($('#igQuit') as HTMLElement).onclick = () => finish(true);
  let E: IglaEngine;
  try {
    const { loadCityData } = await import('./city3d');
    const data = await loadCityData();
    if (!data) throw new Error('The town data (city/) is not in this build: the Igla drill needs the full web build, not the one-file offline copy.');
    E = createIgla(c, data.meta.world);
  } catch (e: any) { toast(e.message ?? String(e)); onExit(); return; }
  L = { E, log: [], q: [], acc: 0, last: performance.now(), raf: 0, done: false, onExit, keys: new Set(), rmb: false, sent: { f: 0, s: 0, run: false, raise: false, az: E.sol.az, el: E.sol.el },
    look: { az: E.sol.az, el: E.sol.el }, sway: { az: 0, el: 0 }, sel: null, seenEv: 0, radio: [], prev: { x: E.sol.x, y: E.sol.y, T: new Map(), M: new Map() }, msg: null,
    channel: c.time === 'night' ? 'ti' : 'day', netCalls: new Map(), ai: false, view: null, snd: fieldAudio('zu23'), tone: iglaSound(), cleanup: [] };
  const me = L;
  ($('#igCond') as HTMLElement).textContent = `${c.time} · ${c.weather ?? 'clear'} · level ${c.difficulty} · ${IGLA.tubes} tubes, ${IGLA.bcus} BCUs`;
  radio('SYS', `You are the Igla gunner in the old town. The air defence net will call contacts by bearing. Find open sky, shoulder the launcher (right button) and identify each contact through the sight (E, then 1–0). Spend a missile only on a target worth one: an ISR drone, a Shahed-type drone, a loitering munition, a jet drone or the large UAV. An FPV is not worth an Igla: get behind a building.`);
  try { me.view = await mountView($('#igMain') as HTMLElement, E, isLite()); } catch (e: any) { toast(`3D view failed: ${e.message ?? e}`); finish(true); return; }
  if (L !== me) { me.view?.dispose(); return; }
  document.getElementById('igLoad')?.remove();
  bindKeys(me);
  panel();
  me.last = performance.now(); me.raf = requestAnimationFrame(loop);
}
export function stopIgla() {
  if (!L) return;
  cancelAnimationFrame(L.raf); L.done = true;
  for (const f of L.cleanup) f();
  L.view?.dispose(); L.snd?.dispose(); L.tone?.dispose(); L = null;
}

// ---------- input ----------
const act = (a: Omit<IglaAction, 'tick'>) => { if (L && !L.done) L.q.push({ ...a, tick: L.E.tick } as IglaAction); };
function bindKeys(me: Live) {
  const order = getConfig().threats.order;
  const down = (e: KeyboardEvent) => {
    if (L !== me || me.done) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'shift'].includes(k)) { me.keys.add(k); return; }
    if (e.repeat) return;
    if (k === 'tab') { e.preventDefault(); cycle(); return; }
    if (k === 'e') { select(); return; }
    if (k === 'f') { act({ k: 'power' }); return; }
    if (k === 'r') { act({ k: 'reload' }); return; }
    if (k === 'b') { act({ k: 'bcu' }); return; }
    if (k === 't') { me.channel = me.channel === 'day' ? 'ti' : 'day'; me.msg = { text: me.channel === 'ti' ? 'SIGHT: THERMAL (WHITE HOT)' : 'SIGHT: DAY CHANNEL', t: performance.now(), col: '#fff' }; me.tone?.click(); return; }
    if (/^[0-9]$/.test(k)) { e.preventDefault(); const i = k === '0' ? 9 : +k - 1; if (order[i]) identify(order[i]); return; }
    if (k === '/') { e.preventDefault(); identify('unknown'); }
  };
  const up = (e: KeyboardEvent) => { me.keys.delete(e.key.toLowerCase()); };
  const blur = () => { me.keys.clear(); me.rmb = false; };
  // Capture phase on window: runs before the gun drills' document handler.
  addEventListener('keydown', down, true); addEventListener('keyup', up, true); addEventListener('blur', blur);
  me.cleanup.push(() => { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); removeEventListener('blur', blur); });
}
function cycle() {
  const E = L!.E, list = E.targets.filter((t) => t.state === 'live' && (L!.netCalls.has(t.id) || iVisible(E, t))).map((t) => t.id);
  if (!list.length) return;
  L!.sel = list[(list.indexOf(L!.sel ?? -1) + 1) % list.length]; panel();
}
function select() {
  const id = L!.view?.centreTarget(); if (id == null) { toast('No contact in the middle of the view (shoulder the launcher to look through the sight)'); return; }
  L!.sel = id; L!.tone?.click(); panel();
}
function identify(cls: string) {
  if (!L || L.sel == null) { toast('Select a contact first: E with it in the middle of the sight, or Tab'); return; }
  const T = L.E.targets.find((t) => t.id === L!.sel);
  if (!T || !iVisible(L.E, T)) { toast(`Contact ${L.sel} is not in sight: look at it (through the sight if it is far)`); return; }
  act({ k: 'ident', cid: L.sel, cls }); setTimeout(panel, 120);
}

// ---------- loop ----------
function tick() {
  const me = L!, E = me.E, k = me.keys;
  if (me.ai) {
    me.q.push(...iglaAI(E)); me.look = { az: E.sol.az, el: E.sol.el };
  } else {
    const f = (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0), s = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0), run = k.has('shift');
    if (f !== me.sent.f || s !== me.sent.s || run !== me.sent.run) { me.sent.f = f; me.sent.s = s; me.sent.run = run; act({ k: 'move', f, s, run }); }
    if (me.rmb !== me.sent.raise) { me.sent.raise = me.rmb; act({ k: 'raise', on: me.rmb }); }
    // Sway of an 18 kg launcher on the shoulder: more when tired from running or walking; it is part of the aim sent.
    const t = E.tick * E.dt, A = E.sol.raise > 0.5 ? 0.1 + 0.45 * E.sol.fatigue + (f || s ? 0.3 : 0) : 0;
    me.sway = { az: A * (Math.sin(t * 1.3) + 0.5 * Math.sin(t * 3.1 + 1)), el: A * (Math.cos(t * 1.1) + 0.4 * Math.sin(t * 2.7)) };
    const az = Math.round((((me.look.az + me.sway.az) % 360) + 360) % 360 * 100) / 100, el = Math.round((me.look.el + me.sway.el) * 100) / 100;
    if (Math.abs(angDiff(az, me.sent.az)) > 0.01 || Math.abs(el - me.sent.el) > 0.01) { me.sent.az = az; me.sent.el = el; act({ k: 'look', az, el }); }
  }
  me.prev = { x: E.sol.x, y: E.sol.y, T: new Map(E.targets.map((t) => [t.id, [...t.p] as Vec3])), M: new Map(E.missiles.map((m) => [m.id, [...m.p] as Vec3])) };
  const acts = me.q.splice(0).map((a) => ({ ...a, tick: E.tick }));
  me.log.push(...acts); stepIgla(E, acts); pump();
  if (iglaDone(E)) finish(false);
}
function loop(now: number) {
  const me = L; if (!me || me.done) return;
  me.acc += Math.min(250, now - me.last); me.last = now;
  const ms = me.E.dt * 1000;
  let n = 0; while (me.acc >= ms && n++ < 5 && !me.done) { me.acc -= ms; tick(); }
  if (me.done || L !== me) return;
  me.view?.frame(me.E, Math.min(1, me.acc / ms), me);
  me.tone?.update(me.E);
  if (me.E.tick % 3 === 0) { panel(); ($('#igClock') as HTMLElement).textContent = clock(me.E); }
  me.raf = requestAnimationFrame(loop);
}
const clock = (E: IglaEngine) => { const s = Math.max(0, iglaMaxTicks(E) - E.tick) * E.dt; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

// ---------- radio, messages, the next step ----------
function radio(who: string, text: string) { if (!L) return; L.radio.push({ t: L.E.tick * L.E.dt, who, text }); }
const T_ = () => getConfig().threats.threats;
const nameOf = (E: IglaEngine, id: number) => { const c = iIdentOf(E, id); return `contact ${id}${c && c !== 'unknown' ? ` (${T_()[c]?.short ?? c})` : ''}`; };
/** The air defence net's call: bearing, range, height and whether it closes; never the type. */
function netCall(E: IglaEngine, T: ITarget, first: boolean): string {
  const r = rel(E, T.p), l = losOf(r), d = Math.hypot(r[0], r[1]), closing = (r[0] * T.v[0] + r[1] * T.v[1]) / (d || 1) < -Math.hypot(T.v[0], T.v[1]) * 0.5;
  return `${first ? 'Air warning! ' : ''}Contact ${T.id}, bearing ${pad3(l.az)}, ${(l.range / 1000).toFixed(1)} km, height ${Math.round(T.p[2] / 50) * 50} m, ${closing ? 'closing' : 'crossing'}`;
}
function pump() {
  const me = L!, E = me.E, now = performance.now();
  const say = (text0: string, col = '#fff', who = 'SYS') => { const text = text0.charAt(0).toUpperCase() + text0.slice(1); radio(who, text); me.msg = { text: text.toUpperCase(), t: now, col }; };
  for (; me.seenEv < E.ev.length; me.seenEv++) {
    const e = E.ev[me.seenEv], tg = e.cid != null ? E.targets.find((t) => t.id === e.cid) : undefined;
    switch (e.k) {
      case 'warn': if (tg) { me.netCalls.set(tg.id, { t: E.tick, brg: losOf(rel(E, tg.p)).az }); say(netCall(E, tg, true), '#F2C94C', 'AD NET'); me.tone?.radio(); } break;
      case 'power': say('BCU on: seeker cooling, ready in 5 s. It lasts about 35 s.', '#F2C94C', 'GUNNER'); me.tone?.spin(); break;
      case 'ready': say('Seeker ready: put the target in the ring', '#9fe0a8'); break;
      case 'lock': me.msg = { text: 'LOCK · lift above and ahead · FIRE', t: now, col: '#22d36a' }; break;
      case 'lockLost': say(`Lock lost on ${nameOf(E, e.cid!)}`, '#F2C94C'); break;
      case 'noLaunch': me.tone?.click(); say(({ raise: 'Shoulder the launcher first (hold right button)', tube: 'Tube spent: R for a fresh tube', off: 'Switch on the BCU first (F)', cooling: 'Seeker still cooling: wait for it', search: 'No lock, no launch: put the target in the ring', acq: 'Still acquiring: wait for the steady tone', lost: 'Lock lost before launch' } as Record<string, string>)[e.text ?? ''] ?? 'No launch', '#FF5C61'); break;
      case 'trigger': me.tone?.click(); break;
      case 'launch': say(`Missile away at ${nameOf(E, e.cid!)}`, '#ffffff', 'GUNNER'); me.view?.launched(); me.tone?.launch(); break;
      case 'destroyed': { say(`${nameOf(E, e.cid!)} destroyed`, '#22d36a', 'GUNNER'); const r = rel(E, tg!.p); me.snd?.boom(Math.hypot(...r), true); break; }
      case 'missileMiss': say(({ unarmed: 'Hit inside the minimum range: the warhead was not armed', ground: 'The missile fell short', selfDestruct: 'Missed: the missile self-destructed', building: 'The missile hit a building or wall: check the launch line' } as Record<string, string>)[e.text ?? ''] ?? 'Missed', '#FF5C61'); break;
      case 'seekerLost': say('The missile seeker lost the target', '#F2C94C'); break;
      case 'bcuOut': say('BCU exhausted before a launch: B for a fresh one', '#FF5C61'); break;
      case 'bcuFit': radio('GUNNER', 'Screwing on a fresh BCU'); me.tone?.clunk(2); break;
      case 'bcuFitted': say('Fresh BCU fitted', '#9fe0a8', 'GUNNER'); break;
      case 'tubeSwap': radio('GUNNER', 'Unlatching the gripstock from the spent tube, onto a fresh one'); me.tone?.clunk(4); break;
      case 'tubeOn': say('Gripstock on the fresh tube: now a fresh BCU (B)', '#9fe0a8', 'GUNNER'); break;
      case 'reloaded': say(`Ready to fire again: reload took ${e.n} s`, '#9fe0a8', 'GUNNER'); break;
      case 'powerFail': say(({ tube: 'Fit a fresh tube first (R)', on: 'The BCU is already on', bcu: 'No working BCU: B to fit a fresh one' } as Record<string, string>)[e.text ?? ''] ?? 'Cannot switch on', '#F2C94C'); break;
      case 'bcuFail': say(({ tube: 'Gripstock onto a fresh tube first (R), then the BCU', have: 'A BCU is already fitted', none: 'No BCUs left' } as Record<string, string>)[e.text ?? ''] ?? 'Cannot fit a BCU', '#F2C94C'); break;
      case 'reloadFail': say(e.text === 'none' ? 'No tubes left' : 'The tube on the gripstock is still live', '#F2C94C'); break;
      case 'busy': break;
      case 'ident': radio('GUNNER', `Contact ${e.cid} is ${e.text === 'unknown' ? 'unknown' : T_()[e.text!]?.short ?? e.text}`); break;
      case 'identFail': say('That contact is not in sight', '#F2C94C'); break;
      case 'struck': say('Hit by an FPV drone in the open!', '#FF5C61'); me.view?.hitFlash(); break;
      case 'fpvCrashed': say(`${nameOf(E, e.cid!)} lost you behind cover and crashed`, '#9fe0a8'); { const r = rel(E, tg!.p); me.snd?.boom(Math.hypot(...r), false); } break;
      case 'assetHit': say(`${nameOf(E, e.cid!)} struck the town`, '#FF5C61'); { const r = rel(E, tg!.p); me.snd?.boom(Math.hypot(...r), true); } break;
      case 'observed': say(`${nameOf(E, e.cid!)} has fixed your position: expect fire`, '#FF5C61', 'AD NET'); break;
      case 'left': radio('AD NET', `${nameOf(E, e.cid!)} has left the area`); break;
    }
  }
  // The net updates its calls every 20 s while a contact is unidentified (and when it comes inside 3 km).
  for (const T of E.targets) {
    const c = me.netCalls.get(T.id); if (!c || T.state !== 'live' || iIdentOf(E, T.id)) continue;
    const r = losOf(rel(E, T.p)).range;
    if (E.tick - c.t >= Math.round(20 / E.dt) || (r < 3000 && !c.near)) { radio('AD NET', netCall(E, T, false)); me.netCalls.set(T.id, { t: E.tick, brg: losOf(rel(E, T.p)).az, near: c.near || r < 3000 }); }
  }
}
/** What to do next, in one line (the coach). */
function nextStep(E: IglaEngine): { text: string; col: string } {
  const S = E.sol, Lc = E.lch, Tt = T_();
  const hunter = E.targets.find((t) => t.state === 'live' && t.goal === 'hunt' && Math.hypot(t.p[0] - S.x, t.p[1] - S.y) < 600);
  if (hunter && (iVisible(E, hunter, true) || Math.hypot(...rel(E, hunter.p)) < (Tt[hunter.type]?.acoustic?.rangeM ?? 300) * 1.2)) return { text: 'FPV coming at you: not worth an Igla. Get behind a building (break its line of sight).', col: '#FF5C61' };
  if (Lc.busy) return { text: `${Lc.busy.k === 'reload' ? 'Gripstock onto a fresh tube' : 'Screwing on a fresh BCU'}… ${Math.max(0, Math.ceil((Lc.busy.until - E.tick) * E.dt))} s`, col: '#F2C94C' };
  if (Lc.tube === 'spent') return Lc.tubes > 0 ? { text: 'Tube spent. R: move the gripstock to a fresh tube.', col: '#F2C94C' } : { text: 'No tubes left. Report and take cover.', col: '#F2C94C' };
  if (Lc.bcu === 'spent' || Lc.bcu === 'none') return Lc.bcus > 0 ? { text: 'B: screw a fresh battery-coolant unit (BCU) onto the gripstock.', col: '#F2C94C' } : { text: 'No BCUs left.', col: '#F2C94C' };
  const live = E.targets.filter((t) => t.state === 'live' && t.type !== 'bird' && (L?.netCalls.has(t.id) || iVisible(E, t, true)));
  if (!live.length) return { text: 'Listen to the air defence net. Find open sky: walk with W A S D.', col: '#ffffff' };
  if (S.raise < 1) return { text: 'Hold the right button: shoulder the launcher and search through the sight, on the bearing the net gives.', col: '#ffffff' };
  const unid = live.filter((t) => iVisible(E, t) && iIdentOf(E, t.id) == null);
  if (unid.length && Lc.seeker !== 'lock') return { text: `Contact${unid.length > 1 ? 's' : ''} in sight: put one in the middle, E to select it, then 1–0 to identify.`, col: '#ffffff' };
  if (Lc.bcu === 'fitted') return { text: 'Target worth a missile? F: switch on the BCU (ready in 5 s, lasts 35 s). An FPV, a friendly, a civil drone or a bird: never.', col: '#ffffff' };
  if (Lc.seeker === 'cooling') return { text: 'Seeker cooling… keep the target in the ring.', col: '#F2C94C' };
  if (Lc.seeker === 'search') return { text: 'Put the target in the ring. Too far, or too faint: no tone (the seeker range depends on the heat it gives off).', col: '#ffffff' };
  if (Lc.seeker === 'acq') return { text: 'Hold steady: pulsing tone, the seeker is acquiring.', col: '#F2C94C' };
  if (!iLaunchClear(E)) return { text: 'LOCK, but a wall or building is in front of the tube: move to clear the launch line.', col: '#FF5C61' };
  return { text: 'LOCK (steady tone, green light). Lift the launcher about 6° above and ahead of the target, then left click to fire.', col: '#22d36a' };
}

// ---------- side panel ----------
function panel() {
  const me = L; if (!me) return;
  const E = me.E, T = T_(), order = getConfig().threats.order, Lc = E.lch;
  const worth = E.targets.filter((t) => t.value === 'high'), kills = worth.filter((t) => t.state === 'destroyed').length;
  const bcu = Lc.busy?.k === 'bcu' ? 'fitting…' : Lc.bcu === 'active' ? `ON · ${Math.ceil(iBcuLeft(E) ?? 0)} s left` : Lc.bcu === 'fitted' ? 'fitted, off' : Lc.bcu === 'spent' ? 'spent' : 'none';
  setHTML($('#igObj'), `<h4>Launcher</h4><ul class="ptObj">
    <li class="${Lc.tube === 'live' ? 'ok' : 'bad'}">Tube on the gripstock: ${Lc.busy?.k === 'reload' ? 'changing…' : Lc.tube === 'live' ? 'live round' : 'spent'} · spare tubes ${Lc.tubes}</li>
    <li class="${Lc.bcu === 'active' || Lc.bcu === 'fitted' ? 'ok' : 'bad'}">BCU: ${bcu} · spare BCUs ${Lc.bcus}</li>
    <li>Seeker: ${({ off: 'off', cooling: 'cooling', search: 'searching', acq: 'acquiring (pulsing tone)', lock: 'LOCKED (steady tone)' } as Record<string, string>)[Lc.seeker]}</li>
    <li>Worth a missile destroyed: ${kills}${worth.length ? ` of ${worth.length} so far` : ''}</li>
    <li class="${E.sol.struck ? 'bad' : ''}">${E.sol.struck ? 'Struck by an FPV' : 'Unhurt'}</li></ul>`);
  if (me.sel != null && !E.targets.some((t) => t.id === me.sel && t.state === 'live')) me.sel = null;
  const listed = E.targets.filter((t) => t.state === 'live' && (me.netCalls.has(t.id) || iVisible(E, t)));
  const S = me.sel != null ? E.targets.find((t) => t.id === me.sel) : undefined;
  let clue = '';
  if (S) {
    const l = losOf(rel(E, S.p)), spd = Math.hypot(S.v[0], S.v[1]), ty = T[S.type], id = iIdentOf(E, S.id), vis = iVisible(E, S);
    clue = `<div class="gnClue"><b>Contact ${S.id}</b> · bearing ${pad3(l.az)}° · ${(l.range / 1000).toFixed(1)} km · height about ${Math.round(S.p[2] / 10) * 10} m · speed about ${Math.round(spd / 5) * 5} m/s
      ${ty.acoustic && l.range <= ty.acoustic.rangeM ? `<br>Sound: ${esc(ty.acoustic.sig)}` : ''}${vis ? '' : '<br><i>Not in sight now: look along the bearing (through the sight if far)</i>'}</div>
      <div class="gnIdKeys">${order.map((k, i) => `<button data-id="${k}" class="${id === k ? 'on' : ''} ${T[k].hostile ? 'h' : T[k].friendly ? 'f' : 'n'}">${esc(T[k].short)}${i < 10 ? `<kbd>${(i + 1) % 10}</kbd>` : ''}</button>`).join('')}<button data-id="unknown" class="${id === 'unknown' ? 'on' : ''}">Unknown<kbd>/</kbd></button></div>`;
  }
  const el = $('#igId') as HTMLElement;
  setHTML(el, `<h4>Contacts <small>E selects the one in the middle · Tab cycles</small></h4><div class="gnContacts">${listed.map((t) => { const id = iIdentOf(E, t.id), v = id && id !== 'unknown' ? (getIglaValue(id)) : ''; return `<button data-sel="${t.id}" class="${t.id === me.sel ? 'sel' : ''}">${t.id} · ${id ? (id === 'unknown' ? 'unknown' : esc(T[id]?.short ?? id)) : '<i>not identified</i>'}${v === 'high' ? ' · <b>worth a missile</b>' : v ? ' · no missile' : ''}${Lc.lockCid === t.id ? ' · LOCK' : ''}</button>`; }).join('') || '<span class="gnNote">No contacts yet. Listen to the net and watch the sky.</span>'}</div>${clue}`);
  el.querySelectorAll<HTMLElement>('[data-sel]').forEach((b) => (b.onclick = () => { me.sel = +b.dataset.sel!; panel(); }));
  el.querySelectorAll<HTMLElement>('[data-id]').forEach((b) => (b.onclick = () => identify(b.dataset.id!)));
  setHTML($('#igRadio'), me.radio.slice(-14).reverse().map((r) => `<p><span class="num">${Math.floor(r.t / 60)}:${String(Math.floor(r.t % 60)).padStart(2, '0')}</span> <b>${esc(r.who)}</b> ${esc(r.text)}</p>`).join(''));
}
const getIglaValue = (type: string) => IGLA.types[type]?.value ?? 'low';

// Test and automation handle: state, the engine, and the expert gunner playing to the end.
(window as any).PARA_IGLA = {
  start: (cfg?: Partial<IglaCfg>) => startIgla(() => undefined, cfg ? defaultIglaCfg(cfg) : undefined),
  state: () => L && { tick: L.E.tick, done: L.done, sol: L.E.sol, lch: L.E.lch, launches: L.E.launches.length },
  engine: () => L?.E,
  ai: (on: boolean) => { if (L) L.ai = on; },
  trig: () => act({ k: 'trig', on: true }),
  /** Run the drill ahead by this many seconds at once (tests, screenshots). */
  skip: (sec: number) => { for (let i = 0; L && !L.done && i < Math.round(sec / L.E.dt); i++) tick(); },
  look: (az: number, el: number, raise?: boolean) => { if (L) { L.look = { az, el }; if (raise != null) L.rmb = raise; } },
  history: () => H,
};

// ---------- end and debrief ----------
function finish(quit: boolean) {
  const me = L; if (!me || me.done) return;
  const E = me.E, sc = scoreIgla(E), onExit = me.onExit;
  me.done = true; cancelAnimationFrame(me.raf);
  if (!quit || E.tick > 300) { H.push({ n: H.length + 1, date: Date.now(), cfg: E.cfg, total: sc.total, rules: sc.rules, metrics: sc.metrics }); save(); }
  stopIgla();
  const pass = sc.total >= getConfig().training.certification.passMark, m = sc.metrics;
  const fix = sc.why.slice(0, 3);
  $('#gunApp').innerHTML = `<div class="gnDebrief"><div class="gnHead"><h2>Igla on foot · debrief</h2><button class="smallBtn" id="igBack">All drills</button><button class="smallBtn solid" id="igAgain">Next drill →</button></div>
    <p class="gnLead"><b class="${pass ? 'ok' : 'bad'}" style="font-size:42px">${sc.total}</b> / 100 · ${pass ? 'PASS' : 'NOT YET'} (pass mark ${getConfig().training.certification.passMark})${quit ? ' · ended early' : ''}</p>
    <p class="gnNote">${m.kills} of ${m.worth} targets worth a missile destroyed · ${m.launches} missile${m.launches === 1 ? '' : 's'} fired, ${m.hits} hit${m.wrongLaunches ? ` · <b class="bad">${m.wrongLaunches} at a target not worth one</b>` : ''} · identified ${m.identified} · ${m.bcuWasted} BCU${m.bcuWasted === 1 ? '' : 's'} wasted${m.reloadSec != null ? ` · reload ${m.reloadSec} s` : ''} · ${m.distanceM} m on foot${m.struck ? ' · <b class="bad">struck by an FPV</b>' : ''}</p>
    ${fix.length ? `<h4>Fix these first</h4><ul class="gnWhy">${fix.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '<p class="gnLead ok">A clean drill.</p>'}
    <details class="gnMore"><summary>Score by rule</summary><div class="gnCols"><div><table class="gnTracks">${sc.parts.map((p) => `<tr><td>${p.rule}</td><td>${esc(p.label)}</td><td class="num">${p.pts} / ${p.max}</td></tr>`).join('')}
      ${sc.deductions.map((d) => `<tr><td>${d.rule}</td><td>${esc(d.label)}</td><td class="num bad">${d.pts}</td></tr>`).join('')}</table>
      ${sc.why.length > 3 ? `<ul class="gnWhy">${sc.why.slice(3).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}</div>
      <div><ul class="gnWhy">${Object.entries(IGLA_RULES).map(([k, v]) => `<li class="${sc.rules.includes(k) ? 'bad' : ''}"><b>${k}</b> ${esc(v)}</li>`).join('')}</ul></div></div></details>
    <p class="gnNote">Simulated scores are training measures, not operational effectiveness. Igla timings, ranges and seeker values are training values, not equipment specifications. ${H.length} Igla drill${H.length === 1 ? '' : 's'} on this computer; the next one is set from your last score.</p></div>`;
  ($('#igBack') as HTMLElement).onclick = onExit;
  ($('#igAgain') as HTMLElement).onclick = () => void startIgla(onExit);
}

// ---------- sounds of the launcher (Web Audio, generated) ----------
interface IglaSound { update: (E: IglaEngine) => void; spin: () => void; launch: () => void; click: () => void; clunk: (n: number) => void; radio: () => void; dispose: () => void; }
function iglaSound(): IglaSound | null {
  if ((app.DB.settings?.sound ?? 'sound') === 'off') return null;
  let ac: AudioContext;
  try { ac = new AudioContext(); } catch { return null; }
  const resume = () => { if (ac.state === 'suspended') void ac.resume(); };
  addEventListener('pointerdown', resume); addEventListener('keydown', resume);
  const out = ac.createGain(); out.gain.value = 0.8; out.connect(ac.destination);
  const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate); { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  // The seeker tone: pulsing while acquiring, steady on lock.
  const tone = ac.createOscillator(), tg = ac.createGain(); tone.type = 'square'; tone.frequency.value = 1180; tg.gain.value = 0;
  const tf = ac.createBiquadFilter(); tf.type = 'lowpass'; tf.frequency.value = 2600; tone.connect(tf).connect(tg).connect(out); tone.start();
  // The BCU: gyro spin-up whine, then a faint hum while it runs.
  const hum = ac.createOscillator(), hg = ac.createGain(); hum.type = 'sawtooth'; hum.frequency.value = 400; hg.gain.value = 0;
  const hf = ac.createBiquadFilter(); hf.type = 'bandpass'; hf.frequency.value = 1400; hf.Q.value = 2; hum.connect(hf).connect(hg).connect(out); hum.start();
  const nz = (t: number, dur: number, type: BiquadFilterType, f: number, g: number, decay: number) => {
    const s = ac.createBufferSource(), fl = ac.createBiquadFilter(), gg = ac.createGain(); s.buffer = noise; s.loop = true; fl.type = type; fl.frequency.value = f;
    gg.gain.setValueAtTime(g, t); gg.gain.exponentialRampToValueAtTime(0.0005, t + decay); s.connect(fl).connect(gg).connect(out); s.start(t); s.stop(t + dur);
  };
  const blip = (t: number, f: number, dur: number, g: number, type: OscillatorType = 'square') => { const o = ac.createOscillator(), gg = ac.createGain(); o.type = type; o.frequency.value = f; gg.gain.setValueAtTime(g, t); gg.gain.exponentialRampToValueAtTime(0.0005, t + dur); o.connect(gg).connect(out); o.start(t); o.stop(t + dur + 0.02); };
  let last = '';
  return {
    update: (E) => {
      const s = E.lch.seeker, t = ac.currentTime;
      const g = s === 'lock' ? 0.07 : s === 'acq' ? (Math.floor(performance.now() / 120) % 2 ? 0.06 : 0) : 0;
      tg.gain.setTargetAtTime(g, t, 0.01);
      const on = E.lch.bcu === 'active';
      hg.gain.setTargetAtTime(on ? 0.012 : 0, t, 0.3);
      if (s !== last) last = s;
    },
    spin: () => { const t = ac.currentTime; hum.frequency.cancelScheduledValues(t); hum.frequency.setValueAtTime(180, t); hum.frequency.exponentialRampToValueAtTime(1500, t + IGLA.readySec); hg.gain.setTargetAtTime(0.03, t, 0.1); nz(t, 1.2, 'highpass', 3000, 0.05, 1.1); },
    launch: () => {
      const t = ac.currentTime;
      nz(t, 0.25, 'lowpass', 900, 0.9, 0.2); // ejection charge
      nz(t + 0.25, 2.5, 'bandpass', 700, 0.5, 2.4); // motor
      nz(t + 0.25, 0.4, 'lowpass', 220, 0.9, 0.5); // the boom of ignition
    },
    click: () => blip(ac.currentTime, 2200, 0.03, 0.08),
    clunk: (n) => { for (let i = 0; i < n; i++) { const t = ac.currentTime + i * 0.6 + Math.random() * 0.2; nz(t, 0.12, 'lowpass', 500, 0.35, 0.1); blip(t, 140, 0.08, 0.1, 'triangle'); } },
    radio: () => { const t = ac.currentTime; nz(t, 0.15, 'bandpass', 2000, 0.06, 0.12); blip(t + 0.02, 1000, 0.05, 0.03); },
    dispose: () => { removeEventListener('pointerdown', resume); removeEventListener('keydown', resume); try { tone.stop(); hum.stop(); } catch { /* stopped */ } void ac.close(); },
  };
}

// ---------- the 3D view ----------
interface View { frame: (E: IglaEngine, f: number, me: Live) => void; centreTarget: () => number | null; launched: () => void; hitFlash: () => void; dispose: () => void; }

/** The launcher: the user's scan if it is on this computer (models/manpad_local.glb, not redistributable, never
 *  committed); otherwise a built-in tube, gripstock, BCU and clip-on sight. Root along −z (forward), metres. */
async function launcherModel(): Promise<{ g: THREE.Group; bcu: THREE.Object3D | null; cap: THREE.Object3D | null }> {
  const scan = await gltf('models/manpad_local.glb');
  const g = new THREE.Group();
  if (scan) {
    // The scan is a skinned mesh in a static pose: bake the pose into plain meshes (world space), then centre it.
    scan.updateMatrixWorld(true);
    const s = new THREE.Group(), v = new THREE.Vector3();
    scan.traverse((o) => {
      const m = o as THREE.SkinnedMesh; if (!m.isMesh) return;
      const geo = m.geometry.clone(), pos = geo.attributes.position as THREE.BufferAttribute;
      if (m.isSkinnedMesh) m.skeleton.update();
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); if (m.isSkinnedMesh) m.applyBoneTransform(i, v); v.applyMatrix4(m.matrixWorld); pos.setXYZ(i, v.x, v.y, v.z); }
      geo.deleteAttribute('skinIndex'); geo.deleteAttribute('skinWeight'); geo.computeVertexNormals(); geo.computeBoundingBox(); geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, m.material); mesh.frustumCulled = false; s.add(mesh);
    });
    // It lies along x, nose towards −x: turn the nose to −z (forward) and scale it to an Igla's 1.7 m.
    const box = new THREE.Box3().setFromObject(s), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    for (const m of s.children) (m as THREE.Mesh).geometry.translate(-c.x, -c.y, -c.z);
    s.rotation.y = -Math.PI / 2; s.scale.setScalar(1.7 / Math.max(size.x, size.y, size.z, 0.01));
    g.add(s);
    return { g, bcu: null, cap: null };
  }
  const olive = new THREE.MeshStandardMaterial({ color: 0x4b5236, roughness: 0.7, metalness: 0.1 }), dark = new THREE.MeshStandardMaterial({ color: 0x1d1f1a, roughness: 0.6, metalness: 0.3 });
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.037, 0.037, 1.7, 20), olive); tube.rotation.x = Math.PI / 2; g.add(tube);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.06, 20), dark); cap.rotation.x = Math.PI / 2; cap.position.z = -0.85; g.add(cap);
  const rear = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.045, 0.12, 20, 1, true), dark); rear.rotation.x = Math.PI / 2; rear.position.z = 0.82; g.add(rear);
  for (const z of [-0.5, 0.2, 0.55]) { const b = new THREE.Mesh(new THREE.TorusGeometry(0.039, 0.006, 6, 20), dark); b.position.z = z; g.add(b); }
  // Gripstock under the tube, trigger guard, and the BCU screwed in front of the grip.
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.16, 0.07), dark); grip.position.set(0, -0.11, -0.12); grip.rotation.x = 0.25; g.add(grip);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.3), dark); body.position.set(0, -0.055, -0.2); g.add(body);
  const bcu = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.14, 14), new THREE.MeshStandardMaterial({ color: 0x6c6f66, roughness: 0.5, metalness: 0.4 }));
  bcu.rotation.x = Math.PI / 2; bcu.position.set(0, -0.09, -0.39); g.add(bcu);
  // Clip-on sight on the left of the tube (thermal / night sight), eyepiece to the rear.
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.22), dark); sight.position.set(-0.085, 0.03, -0.05); g.add(sight);
  const ob = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 16), dark); ob.rotation.x = Math.PI / 2; ob.position.set(-0.085, 0.035, -0.18); g.add(ob);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.026, 16), new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.1, metalness: 0.8 })); lens.position.set(-0.085, 0.035, -0.206); lens.rotation.y = Math.PI; g.add(lens);
  const eyep = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.05, 16), dark); eyep.rotation.x = Math.PI / 2; eyep.position.set(-0.085, 0.035, 0.08); g.add(eyep);
  g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.frustumCulled = false; });
  return { g, bcu, cap };
}

async function mountView(host: HTMLElement, E0: IglaEngine, lite: boolean): Promise<View> {
  const cfg = E0.cfg, night = cfg.time === 'night', wx = cfg.weather ?? 'clear';
  const renderer = new THREE.WebGLRenderer({ antialias: !lite, powerPreference: 'high-performance' });
  renderer.setPixelRatio(lite ? 0.8 : Math.min(1.5, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = night ? 0.95 : 0.8;
  renderer.shadowMap.enabled = !lite; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const cv = renderer.domElement; cv.className = 'fdGl';
  const hud = document.createElement('canvas'); hud.className = 'fdHud';
  const tip = document.createElement('div'); tip.className = 'fdTip';
  tip.innerHTML = '<b>Click to take up the launcher</b><span>W A S D walk · Shift run · mouse look · hold right button: shoulder and sight · F BCU on · left click fire on lock · R tube · B BCU · E select · 1–0 identify · Esc releases the mouse</span>';
  host.append(cv, hud, tip);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(FOV_EYE, 1, 0.05, 12000);
  scene.add(camera);
  const sky = await hdr(night ? 'night' : wx === 'clear' ? 'day' : wx === 'rain' ? 'overcast' : wx);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const skyBg: THREE.Texture | THREE.Color = sky ?? new THREE.Color(night ? 0x060a12 : 0x9fb6c8);
  if (sky) { scene.background = sky; scene.environment = pmrem.fromEquirectangular(sky).texture; scene.backgroundIntensity = night ? 0.6 : 1; }
  else { scene.background = skyBg; scene.add(new THREE.HemisphereLight(0xdfe9f2, 0x5b5a48, night ? 0.2 : 0.9)); }
  const sunDir = new THREE.Vector3(-0.5, night ? 0.5 : 0.75, -0.35).normalize();
  const sun = new THREE.DirectionalLight(night ? 0x7f93b8 : 0xfff0d8, night ? 0.3 : wx === 'clear' ? 2.8 : 1.0);
  sun.castShadow = !lite; sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, near: 1, far: 400 }); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  const hazeCol = new THREE.Color(night ? 0x0a0f18 : wx === 'dust' ? 0xb19a78 : wx === 'clear' ? 0xc4cfd6 : 0x9aa3a8);
  const fog = new THREE.Fog(hazeCol, wx === 'clear' ? 300 : 140, wx === 'clear' ? 4500 : wx === 'dust' ? 1200 : 2000); scene.fog = fog;
  const city: City | null = await buildCity(scene, lite, !lite);
  const heightAt = (x: number, z: number) => city?.heightAt(x, z) ?? 0;

  // ---------- the launcher in the gunner's hands ----------
  const lm = await launcherModel(), vm = lm.g;
  camera.add(vm);
  const handLight = new THREE.PointLight(0xffffff, night ? 0.6 : 0, 2.5); camera.add(handLight); handLight.position.set(0.2, -0.1, -0.3);

  // ---------- drones, missiles, effects ----------
  const droneLib = await gltf('models/drones.glb'), dot = dotTexture();
  const better: Record<string, THREE.Group | null> = { fpv: await gltf('models/drone_fpv.glb'), swarm: await gltf('models/drone_swarm.glb'), male: await gltf('models/drone_male.glb') };
  interface Vis { g: THREE.Object3D; props: THREE.Object3D[]; speck: THREE.Sprite; hot: THREE.Sprite; fall?: { t0: number; p: THREE.Vector3; v: THREE.Vector3 } }
  const vis = new Map<number, Vis>();
  const droneOf = (type: string): THREE.Object3D => {
    const s = better[type]?.getObjectByName(`drone_${type}`) ?? droneLib?.getObjectByName(`drone_${type}`) ?? droneLib?.getObjectByName('drone_fpv');
    if (s) { const c = s.clone(true); c.position.set(0, 0, 0); return c; }
    return new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.15, 0.4), new THREE.MeshStandardMaterial({ color: 0x333333 }));
  };
  const fx = new THREE.Group(); scene.add(fx);
  const puffs: { s: THREE.Sprite; t0: number; life: number; grow: number; kind: 'smoke' | 'flash' | 'dust' }[] = [];
  const puff = (at: THREE.Vector3, t: number, kind: 'smoke' | 'flash' | 'dust', size: number, life: number, col = 0x2d2d2d) => {
    if (puffs.length > 400) { const o = puffs.shift()!; fx.remove(o.s); o.s.material.dispose(); }
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: kind === 'flash' ? 0xffd27a : col, transparent: true, depthWrite: false, fog: kind !== 'flash', blending: kind === 'flash' ? THREE.AdditiveBlending : THREE.NormalBlending }));
    s.position.copy(at); s.scale.setScalar(size); fx.add(s); puffs.push({ s, t0: t, life, grow: size, kind });
  };
  const mGeo = new THREE.CylinderGeometry(0.036, 0.036, 1.6, 10); mGeo.rotateX(Math.PI / 2);
  const mMat = new THREE.MeshStandardMaterial({ color: 0x8a8f86, roughness: 0.5 });
  const missiles = new Map<number, { g: THREE.Mesh; flame: THREE.Sprite; lastPuff: number; ended: boolean }>();
  let precip: THREE.Object3D | null = null;
  if (!lite && (wx === 'rain' || wx === 'dust')) {
    const n = wx === 'rain' ? 3000 : 1500, p = new Float32Array(n * (wx === 'rain' ? 6 : 3)); let s = 7;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) { const x = (r() - 0.5) * 60, y = r() * 30, z = (r() - 0.5) * 60; if (wx === 'rain') p.set([x, y, z, x + 0.04, y - 0.7, z], i * 6); else p.set([x, y, z], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    precip = wx === 'rain' ? new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xb4bec8, transparent: true, opacity: 0.3, fog: false })) : new THREE.Points(g, new THREE.PointsMaterial({ color: 0xb59c72, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.5 }));
    precip.frustumCulled = false; scene.add(precip);
  }

  // ---------- input ----------
  let locked = false, hitT = -1e9, kick = 0, launchT = -1e9;
  const onLock = () => { locked = document.pointerLockElement === cv; tip.style.display = locked ? 'none' : ''; if (!locked && L) L.rmb = false; };
  document.addEventListener('pointerlockchange', onLock);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('mousedown', (e) => {
    if (!locked) { if (e.button === 0) void cv.requestPointerLock(); return; }
    if (!L) return;
    if (e.button === 0) act({ k: 'trig', on: true });
    if (e.button === 2) L.rmb = true;
    if (e.button === 1) { e.preventDefault(); select(); }
  });
  const mup = (e: MouseEvent) => { if (e.button === 2 && L) L.rmb = false; };
  addEventListener('mouseup', mup);
  cv.addEventListener('mousemove', (e) => {
    if (!locked || !L || L.ai) return;
    const k = (camera.fov / Math.max(1, host.clientHeight)) * 0.9;
    L.look.az = (L.look.az + e.movementX * k + 360) % 360; L.look.el = Math.max(-20, Math.min(85, L.look.el - e.movementY * k));
  });
  const ro = new ResizeObserver(() => { const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); hud.width = w * devicePixelRatio; hud.height = h * devicePixelRatio; });
  ro.observe(host);
  const project = (p: THREE.Vector3) => { const v = p.clone().project(camera); return { x: ((v.x + 1) / 2) * host.clientWidth, y: ((1 - v.y) / 2) * host.clientHeight, front: v.z < 1 && v.z > -1 }; };
  let lastE = E0, lastF = 0;
  const posOf = (T: ITarget) => { const pr = L?.prev.T.get(T.id); return pr ? ([pr[0] + (T.p[0] - pr[0]) * lastF, pr[1] + (T.p[1] - pr[1]) * lastF, pr[2] + (T.p[2] - pr[2]) * lastF] as Vec3) : iTargetAt(T, lastF); };
  const centreTarget = () => {
    let best: number | null = null, bd = 60;
    for (const T of lastE.targets) { if (!iVisible(lastE, T)) continue; const s = project(W3(posOf(T))); if (!s.front) continue; const d = Math.hypot(s.x - host.clientWidth / 2, s.y - host.clientHeight / 2); if (d < bd) { bd = d; best = T.id; } }
    return best;
  };

  // ---------- per frame ----------
  const hctx = hud.getContext('2d')!, tmp = new THREE.Vector3();
  const tiSky = new THREE.Color(0x141414), tiFog = new THREE.Color(0x2a2a2a);
  let evSeen = 0, bob = 0;
  function frame(E: IglaEngine, f: number, me: Live) {
    const now = performance.now(), t = (E.tick - 1 + f) * E.dt;
    lastE = E; lastF = f;
    const x = me.prev.x + (E.sol.x - me.prev.x) * f, y = me.prev.y + (E.sol.y - me.prev.y) * f, raise = E.sol.raise;
    const moving = Math.hypot(E.sol.x - me.prev.x, E.sol.y - me.prev.y) / E.dt;
    bob += moving * 0.016 * 5.5;
    const scoped = raise >= 0.97 && !E.lch.busy;
    // Camera: the gunner's eye (head bob when walking, less on the shoulder); the aim is the look plus the sway.
    const az = me.ai ? E.sol.az : me.look.az + me.sway.az, el = me.ai ? E.sol.el : me.look.el + me.sway.el;
    kick *= 0.9;
    const bobY = Math.sin(bob) * 0.03 * Math.min(1, moving / 2) * (1 - raise), bobX = Math.cos(bob * 0.5) * 0.02 * Math.min(1, moving / 2) * (1 - raise);
    camera.position.set(x + bobX * Math.cos(az * D2R), heightAt(x, -y) + IGLA.eyeM + bobY, -(y - bobX * Math.sin(az * D2R)));
    camera.rotation.set((el + kick * 2) * D2R, -az * D2R, Math.sin(now * 0.03) * kick * 0.02, 'YXZ');
    camera.fov = scoped ? FOV_SIGHT : FOV_EYE + (moving > 3 ? 4 : 0); camera.updateProjectionMatrix();
    // The launcher: carried at the hip, swung up onto the right shoulder as it is raised; lowered out of sight to reload.
    const busy = E.lch.busy ? Math.min(1, Math.min((E.tick - (E.lch.busy.until - Math.round((E.lch.busy.k === 'reload' ? IGLA.tubeSwapSec : IGLA.bcuFitSec) / E.dt))) * E.dt, (E.lch.busy.until - E.tick) * E.dt) / 0.8) : 0;
    const k = raise * raise * (3 - 2 * raise);
    vm.visible = !scoped;
    vm.position.set(0.3 - 0.16 * k, -0.42 + 0.33 * k - busy * 0.5 + bobY * 0.5, -0.38 + 0.08 * k);
    vm.rotation.set((1 - k) * 0.55 + busy * 0.6, (1 - k) * 0.25, (1 - k) * -0.35);
    if (lm.bcu) lm.bcu.visible = E.lch.bcu === 'fitted' || E.lch.bcu === 'active';
    if (lm.cap) lm.cap.visible = E.lch.tube === 'live';
    // Through the sight: the thermal channel (white hot, cold sky), or the day channel.
    const ti = scoped && me.channel === 'ti';
    cv.style.filter = ti ? 'grayscale(1) contrast(1.45) brightness(1.1)' : scoped && night ? 'brightness(1.4)' : '';
    scene.background = ti ? tiSky : skyBg;
    fog.color.copy(ti ? tiFog : hazeCol);
    syncTargets(E, t, now, scoped, ti, me);
    syncMissiles(E, t, f, me);
    for (; evSeen < E.ev.length; evSeen++) {
      const e = E.ev[evSeen], tg = e.cid != null ? E.targets.find((q) => q.id === e.cid) : undefined;
      if (e.k === 'missileMiss') { const m = E.missiles.find((q) => q.id === e.n); if (m) { puff(W3(m.p), t, 'flash', 4, 0.3); puff(W3(m.p), t, 'smoke', 4, 4, 0x3a3a3a); } }
      if ((e.k === 'fpvCrashed' || e.k === 'assetHit' || e.k === 'struck') && tg) { puff(W3(tg.p), t, 'flash', 7, 0.4); puff(W3(tg.p), t, 'smoke', 6, 6, 0x262320); }
    }
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i], a = (t - p.t0) / p.life;
      if (a >= 1 || a < -0.5) { fx.remove(p.s); p.s.material.dispose(); puffs.splice(i, 1); continue; }
      p.s.material.opacity = p.kind === 'flash' ? 1 - a : (p.kind === 'dust' ? 0.55 : 0.7) * (1 - a);
      p.s.scale.setScalar(p.grow * (p.kind === 'flash' ? 1 + a : 1 + a * 2.5)); if (p.kind !== 'flash') p.s.position.y += 0.01;
    }
    me.snd?.hear(E.targets.map((tg) => ({ id: tg.id, type: tg.type, p: tg.state === 'live' ? rel(E, tg.p) : null })), az, el);
    sun.target.position.set(x, 0, -y); sun.position.copy(sunDir).multiplyScalar(150).add(sun.target.position);
    if (precip) precip.position.set(camera.position.x, camera.position.y - 8 - ((now / (wx === 'rain' ? 35 : 500)) % 10), camera.position.z);
    renderer.render(scene, camera);
    drawHud(E, me, now, scoped, ti, az, el);
  }
  function syncTargets(E: IglaEngine, t: number, now: number, scoped: boolean, ti: boolean, me: Live) {
    // Specks a constant few pixels whatever the zoom: a drone the gunner could see at this range shows as a dot.
    const sk = (2 * Math.tan((camera.fov * D2R) / 2) * (ti ? 6 : 4)) / Math.max(1, host.clientHeight);
    for (const T of E.targets) {
      let v = vis.get(T.id);
      if (!v) {
        const g = droneOf(T.type), props: THREE.Object3D[] = []; g.traverse((o) => { if (/^prop/.test(o.name)) props.push(o); });
        const speck = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: night ? 0x9aa2ab : 0x101010, fog: false, depthWrite: false, sizeAttenuation: false, transparent: true }));
        const hot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: 0xffffff, fog: false, depthWrite: false, sizeAttenuation: false, transparent: true, blending: THREE.AdditiveBlending }));
        v = { g, props, speck, hot }; vis.set(T.id, v); scene.add(g, speck, hot);
      }
      if (T.state === 'destroyed' && T.endTick != null) {
        if (!v.fall) { const p = W3(T.p); v.fall = { t0: T.endTick * E.dt, p, v: new THREE.Vector3(T.v[0] * 0.3, 2, -T.v[1] * 0.3) }; puff(p, t, 'flash', 9, 0.4); puff(p.clone(), t, 'smoke', 7, 6, 0x2a2622); }
        const s = t - v.fall.t0, yy = v.fall.p.y + v.fall.v.y * s - 4.9 * s * s, gy = heightAt(v.fall.p.x, v.fall.p.z);
        v.g.visible = s < 30; v.speck.visible = false; v.hot.visible = ti && yy > gy && s < 30;
        v.g.position.set(v.fall.p.x + v.fall.v.x * Math.min(s, 3), Math.max(gy + 0.1, yy), v.fall.p.z + v.fall.v.z * Math.min(s, 3)); v.hot.position.copy(v.g.position);
        if (yy > gy) { v.g.rotation.x += 0.12; v.g.rotation.z += 0.08; if (Math.random() < 0.3) puff(v.g.position.clone(), t, 'smoke', 2, 3, 0x222222); }
        continue;
      }
      if (T.state !== 'live') { v.g.visible = v.speck.visible = v.hot.visible = false; continue; }
      const p = posOf(T); W3(p, v.g.position); v.speck.position.copy(v.g.position); v.hot.position.copy(v.g.position);
      v.g.rotation.set(0, -Math.atan2(T.v[0], T.v[1]) + Math.PI, Math.sin(now * 0.002 + T.id) * 0.05);
      const seen = iVisible(E, T, scoped);
      v.g.visible = true; v.speck.visible = seen && !ti; v.speck.material.opacity = 0.9; v.speck.scale.setScalar(sk);
      // Thermal: the engine is a white-hot point, brighter for a hot engine (jet, piston) than a battery quad.
      const heat = Math.min(1, IGLA.types[T.type]?.irM ? IGLA.types[T.type].irM / 3500 : 0.4);
      v.hot.visible = seen && ti; v.hot.scale.setScalar(sk * (0.8 + heat)); v.hot.material.opacity = 0.55 + 0.45 * heat;
      for (const r of v.props) r.rotateY(1.9);
    }
    void me;
  }
  function syncMissiles(E: IglaEngine, t: number, f: number, me: Live) {
    for (const m of E.missiles) {
      let v = missiles.get(m.id);
      if (!v) {
        const g = new THREE.Mesh(mGeo, mMat); const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: 0xffe0a0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true }));
        flame.scale.setScalar(1.6); scene.add(g, flame); v = { g, flame, lastPuff: 0, ended: false }; missiles.set(m.id, v);
      }
      if (m.state !== 'fly') { if (!v.ended) { v.ended = true; v.g.visible = v.flame.visible = false; } continue; }
      const pr = me.prev.M.get(m.id) ?? m.prev, p: Vec3 = [pr[0] + (m.p[0] - pr[0]) * f, pr[1] + (m.p[1] - pr[1]) * f, pr[2] + (m.p[2] - pr[2]) * f];
      W3(p, v.g.position); v.flame.position.copy(v.g.position);
      const d = W3(m.v, tmp).normalize(); v.g.lookAt(v.g.position.clone().add(d)); v.g.rotateY(Math.PI);
      const age = (E.tick - m.tick0 + f) * E.dt, burning = age > IGLA.ejectSec && age < IGLA.burnSec;
      v.flame.visible = burning; v.flame.scale.setScalar(burning ? 1.2 + Math.random() * 0.8 : 0);
      if (burning && t - v.lastPuff > 0.03) { v.lastPuff = t; puff(v.g.position.clone(), t, 'smoke', 1.2, 4 + Math.random() * 2, 0xd8d8d0); }
    }
  }
  function drawHud(E: IglaEngine, me: Live, now: number, scoped: boolean, ti: boolean, az: number, el: number) {
    const c = hctx, w = hud.width, h = hud.height, dp = devicePixelRatio, cx = w / 2, cy = h / 2, T = T_(), Lc = E.lch;
    c.clearRect(0, 0, w, h); c.font = `600 ${14 * dp}px Barlow Condensed, sans-serif`; c.lineWidth = 1.4 * dp;
    if (scoped) {
      // ---- the sight picture ----
      const R = Math.min(w, h) * 0.46, pxDeg = (h / 2 / Math.tan((FOV_SIGHT / 2) * D2R)) * Math.tan(D2R);
      const ink = ti ? 'rgba(120,255,140,0.95)' : night ? 'rgba(255,90,60,0.95)' : 'rgba(20,20,20,0.92)';
      c.strokeStyle = ink; c.fillStyle = ink; c.lineWidth = 1.5 * dp;
      // Seeker field of view: the ring the target must sit in; centre dot.
      c.beginPath(); c.arc(cx, cy, IGLA.seekConeDeg * pxDeg, 0, 7); c.stroke();
      c.beginPath(); c.arc(cx, cy, 1.8 * dp, 0, 7); c.fill();
      // Horizontal: lead marks every 2°, both sides. Below the centre: super-elevation marks (put the target on 4–8).
      c.beginPath(); c.moveTo(cx - R, cy); c.lineTo(cx - IGLA.seekConeDeg * pxDeg - 4 * dp, cy); c.moveTo(cx + IGLA.seekConeDeg * pxDeg + 4 * dp, cy); c.lineTo(cx + R, cy); c.stroke();
      c.font = `600 ${11 * dp}px Barlow Condensed, sans-serif`;
      for (let d = 2; d <= 10; d += 2) {
        for (const sx of [-1, 1]) { const xx = cx + sx * d * pxDeg; if (Math.abs(xx - cx) < R - 10 * dp) { c.beginPath(); c.moveTo(xx, cy - 6 * dp); c.lineTo(xx, cy + 6 * dp); c.stroke(); c.fillText(String(d), xx - 3 * dp, cy - 9 * dp); } }
        const yy = cy + d * pxDeg; if (yy - cy < R - 10 * dp) { const wd = (d >= 4 && d <= 8 ? 10 : 6) * dp; c.beginPath(); c.moveTo(cx - wd, yy); c.lineTo(cx + wd, yy); c.stroke(); c.fillText(String(d), cx + wd + 3 * dp, yy + 4 * dp); }
      }
      c.beginPath(); c.moveTo(cx, cy - R); c.lineTo(cx, cy - IGLA.seekConeDeg * pxDeg - 4 * dp); c.stroke();
      // Brackets on selected and identified contacts in the picture.
      for (const tg of E.targets) {
        if (tg.state !== 'live' || !iVisible(E, tg)) continue;
        const id = iIdentOf(E, tg.id); if (!id && tg.id !== me.sel) continue;
        const s = project(W3(posOf(tg))); if (!s.front) continue;
        const X = s.x * dp, Y = s.y * dp, b = 12 * dp, col = !id || id === 'unknown' ? '#F2C94C' : IGLA.types[id]?.value === 'high' ? '#FF5C61' : T[id]?.hostile ? '#ff9f5c' : '#5DA9FF';
        if (Math.hypot(X - cx, Y - cy) > R - b) continue;
        c.strokeStyle = col; c.lineWidth = (tg.id === me.sel ? 2 : 1.3) * dp;
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { c.beginPath(); c.moveTo(X + sx * b, Y + sy * b * 0.45); c.lineTo(X + sx * b, Y + sy * b); c.lineTo(X + sx * b * 0.45, Y + sy * b); c.stroke(); }
        c.fillStyle = col; c.fillText(`${tg.id}${id ? ' ' + (id === 'unknown' ? '?' : T[id]?.short ?? id) : ''} ${(Math.hypot(...rel(E, tg.p)) / 1000).toFixed(1)} km`, X + b + 3 * dp, Y - b + 9 * dp);
      }
      // Lamps (gripstock indicators): power, seeker ready, lock (blinking while acquiring).
      const lamp = (i: number, label: string, on: boolean, col: string) => {
        const X = cx + R * 0.55, Y = cy - R * 0.62 + i * 22 * dp;
        c.beginPath(); c.arc(X, Y, 6 * dp, 0, 7); c.fillStyle = on ? col : 'rgba(60,60,60,0.9)'; c.fill(); c.strokeStyle = 'rgba(0,0,0,0.6)'; c.stroke();
        c.fillStyle = ti ? 'rgba(200,255,210,0.95)' : night ? 'rgba(255,170,150,0.95)' : 'rgba(10,10,10,0.9)'; c.font = `700 ${12 * dp}px Barlow Condensed, sans-serif`; c.fillText(label, X + 11 * dp, Y + 4 * dp);
      };
      const blink = Math.floor(now / 150) % 2 === 0;
      lamp(0, 'PWR', Lc.bcu === 'active', '#F2C94C');
      lamp(1, 'READY', Lc.seeker === 'search' || Lc.seeker === 'acq' || Lc.seeker === 'lock', '#9fe0a8');
      lamp(2, 'LOCK', Lc.seeker === 'lock' || (Lc.seeker === 'acq' && blink), '#22d36a');
      // Mask: everything outside the eyepiece is black, with a soft edge.
      c.save(); c.fillStyle = 'rgba(0,0,0,1)'; c.beginPath(); c.rect(0, 0, w, h); c.moveTo(cx + R, cy); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill('evenodd');
      const gr = c.createRadialGradient(cx, cy, R * 0.82, cx, cy, R); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.85)'); c.fillStyle = gr; c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fill(); c.restore();
      // Sight status under the eyepiece: channel, BCU time, launch line.
      // Sight status in the dark margin, left: channel, bearing, elevation, BCU time.
      c.font = `600 ${15 * dp}px Barlow Condensed, sans-serif`; c.fillStyle = '#9fe0a8';
      const bl = iBcuLeft(E), sx = 18 * dp, sy = 80 * dp, bw = Math.min(110 * dp, Math.max(60 * dp, cx - R - 30 * dp));
      [ti ? 'TI · WHITE HOT' : 'DAY CHANNEL', '3× · T switches', `${pad3(az)}°`, `EL ${el.toFixed(1)}°`, bl != null ? `BCU ${Math.ceil(bl)} s` : Lc.bcu === 'fitted' ? 'BCU OFF (F)' : 'NO BCU (B)'].forEach((s, i) => c.fillText(s, sx, sy + i * 20 * dp));
      if (bl != null) { c.fillStyle = 'rgba(255,255,255,0.2)'; c.fillRect(sx, sy + 92 * dp, bw, 5 * dp); c.fillStyle = bl < 8 ? '#FF5C61' : '#F2C94C'; c.fillRect(sx, sy + 92 * dp, bw * (bl / IGLA.bcuSec), 5 * dp); }
      if (Lc.seeker === 'lock' && !iLaunchClear(E)) { c.fillStyle = '#FF5C61'; c.font = `700 ${18 * dp}px Barlow Condensed, sans-serif`; const t2 = 'LAUNCH LINE BLOCKED'; c.fillText(t2, cx - c.measureText(t2).width / 2, cy - R * 0.55); }
    } else {
      // ---- by eye ----
      c.beginPath(); c.arc(cx, cy, 2.4 * dp, 0, 7); c.fillStyle = 'rgba(255,255,255,0.9)'; c.fill();
      // Compass tape with the air defence net's calls (bearing only) and drones heard but not seen.
      const pxD = 4 * dp;
      c.fillStyle = 'rgba(0,0,0,0.4)'; c.fillRect(cx - 200 * dp, 8 * dp, 400 * dp, 24 * dp); c.fillStyle = 'rgba(255,255,255,0.9)'; c.font = `600 ${13 * dp}px Barlow Condensed, sans-serif`;
      for (let a = Math.ceil((az - 50) / 5) * 5; a <= az + 50; a += 5) { const xx = cx + angDiff(a, az) * pxD; if (Math.abs(xx - cx) > 196 * dp) continue; c.fillRect(xx, 24 * dp, dp, (a % 10 ? 4 : 8) * dp); if (a % 30 === 0) c.fillText(a % 360 === 0 ? 'N' : a % 360 === 90 ? 'E' : a % 360 === 180 ? 'S' : a % 360 === 270 ? 'W' : pad3(a), xx - 8 * dp, 21 * dp); }
      c.fillText(`${pad3(az)}°  EL ${el.toFixed(0)}°`, cx - 30 * dp, 48 * dp);
      const mark = (brg: number, col: string, label: string) => {
        const d = angDiff(brg, az), xx = Math.abs(d) <= 48 ? cx + d * pxD : cx + Math.sign(d) * 196 * dp;
        c.fillStyle = col; c.beginPath(); c.moveTo(xx, 34 * dp); c.lineTo(xx - 5 * dp, 42 * dp); c.lineTo(xx + 5 * dp, 42 * dp); c.fill();
        c.fillText(Math.abs(d) > 48 ? `${d > 0 ? '' : '◀ '}${label}${d > 0 ? ' ▶' : ''}` : label, xx + (d > 0 && Math.abs(d) > 48 ? -46 : -6) * dp, 58 * dp);
      };
      for (const tg of E.targets) {
        if (tg.state !== 'live') continue;
        const id = iIdentOf(E, tg.id), call = me.netCalls.get(tg.id), r = rel(E, tg.p);
        if (call) mark(id ? losOf(r).az : call.brg, !id || id === 'unknown' ? '#F2C94C' : IGLA.types[id]?.value === 'high' ? '#FF5C61' : '#5DA9FF', `${tg.id}`);
        const ac = T[tg.type]?.acoustic;
        if (!call && ac && tg.type !== 'bird' && Math.hypot(...r) < ac.rangeM && !iVisible(E, tg)) mark(Math.round(losOf(r).az / 10) * 10, 'rgba(242,201,76,0.8)', '♪');
      }
      drawMap(c, E, me, 16 * dp, h - 196 * dp, 180 * dp, dp, az);
    }
    // The next step (coach) and the launcher, bottom.
    const ns = nextStep(E);
    c.font = `600 ${15 * dp}px Barlow Condensed, sans-serif`;
    const tw = c.measureText(ns.text).width; c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(cx - tw / 2 - 10 * dp, h - 40 * dp, tw + 20 * dp, 26 * dp); c.fillStyle = ns.col; c.fillText(ns.text, cx - tw / 2, h - 22 * dp);
    if (!scoped) {
      const lines: [string, string][] = [
        [`TUBE ${Lc.busy?.k === 'reload' ? 'CHANGING…' : Lc.tube === 'live' ? 'LIVE' : 'SPENT · R'}  ·  SPARE ${Lc.tubes}`, Lc.tube === 'live' ? '#ffffff' : '#F2C94C'],
        [`BCU ${Lc.busy?.k === 'bcu' ? 'FITTING…' : Lc.bcu === 'active' ? `ON ${Math.ceil(iBcuLeft(E) ?? 0)} s` : Lc.bcu === 'fitted' ? 'OFF · F' : Lc.bcu === 'spent' ? 'SPENT · B' : 'NONE · B'}  ·  SPARE ${Lc.bcus}`, Lc.bcu === 'active' || Lc.bcu === 'fitted' ? '#ffffff' : '#F2C94C'],
        [`${E.sol.running ? 'RUNNING' : ''}${E.sol.fatigue > 0.3 ? ' · BREATHING HARD' : ''}`, '#F2C94C'],
      ];
      lines.forEach(([s, col], i) => { if (!s) return; c.fillStyle = 'rgba(0,0,0,0.45)'; const sw = c.measureText(s).width; c.fillRect(w - sw - 26 * dp, h - (76 + i * 24) * dp, sw + 14 * dp, 21 * dp); c.fillStyle = col; c.fillText(s, w - sw - 19 * dp, h - (60 + i * 24) * dp); });
    }
    if (me.msg && now - me.msg.t < 2600) { c.font = `700 ${22 * dp}px Barlow Condensed, sans-serif`; c.globalAlpha = Math.min(1, (2600 - (now - me.msg.t)) / 500); c.fillStyle = me.msg.col; const mw = c.measureText(me.msg.text).width; c.fillText(me.msg.text, cx - mw / 2, 96 * dp); c.globalAlpha = 1; }
    if (now - launchT < 600) { c.fillStyle = `rgba(255,240,200,${0.5 * (1 - (now - launchT) / 600)})`; c.fillRect(0, 0, w, h); }
    if (now - hitT < 1500) { c.fillStyle = `rgba(255,60,40,${0.45 * (1 - (now - hitT) / 1500)})`; c.fillRect(0, 0, w, h); }
  }
  // Pre-drawn town map (north up).
  const W = E0.W, mapC = document.createElement('canvas'), MS = 512; mapC.width = mapC.height = MS;
  { const m = mapC.getContext('2d')!, k = MS / (2 * W.half + 40), ox = W.centre[0] - W.half - 20, oy = W.centre[1] + W.half + 20;
    m.fillStyle = 'rgba(20,26,22,0.85)'; m.fillRect(0, 0, MS, MS);
    m.fillStyle = 'rgba(70,74,68,0.9)'; for (const r of W.roads) { const hw = r[4] / 2; m.fillRect((Math.min(r[0], r[2]) - hw - ox) * k, (oy - Math.max(r[1], r[3]) - hw) * k, (Math.abs(r[2] - r[0]) + 2 * hw) * k, (Math.abs(r[3] - r[1]) + 2 * hw) * k); }
    m.fillStyle = 'rgba(190,178,150,0.85)'; for (const b of W.boxes) m.fillRect((b[0] - ox) * k, (oy - b[3]) * k, (b[2] - b[0]) * k, (b[3] - b[1]) * k);
    m.fillStyle = 'rgba(255,255,255,0.7)'; m.font = '12px Barlow Condensed, sans-serif'; for (const l of W.landmarks) m.fillText(l.name, (l.x - ox) * k - 20, (oy - l.y) * k); }
  function drawMap(c: CanvasRenderingContext2D, E: IglaEngine, me: Live, x0: number, y0: number, S: number, dp: number, az: number) {
    const k = S / (2 * W.half + 40), ox = W.centre[0] - W.half - 20, oy = W.centre[1] + W.half + 20, X = (x: number) => x0 + (x - ox) * k, Y = (y: number) => y0 + (oy - y) * k;
    c.globalAlpha = 0.9; c.drawImage(mapC, x0, y0, S, S); c.globalAlpha = 1;
    const px = X(E.sol.x), py = Y(E.sol.y);
    // Air defence net bearing lines to the contacts it has called.
    for (const [id, call] of me.netCalls) { const tg = E.targets.find((q) => q.id === id); if (!tg || tg.state !== 'live') continue; const b = (iIdentOf(E, id) ? losOf(rel(E, tg.p)).az : call.brg) * D2R; c.strokeStyle = 'rgba(242,201,76,0.6)'; c.lineWidth = dp; c.beginPath(); c.moveTo(px, py); c.lineTo(px + Math.sin(b) * S, py - Math.cos(b) * S); c.stroke(); }
    c.save(); c.beginPath(); c.rect(x0, y0, S, S); c.clip();
    c.fillStyle = '#22d36a'; c.beginPath(); c.arc(px, py, 4 * dp, 0, 7); c.fill();
    const a = az * D2R; c.fillStyle = 'rgba(34,211,106,0.25)'; c.beginPath(); c.moveTo(px, py); c.arc(px, py, 26 * dp, a - Math.PI / 2 - 0.4, a - Math.PI / 2 + 0.4); c.fill();
    c.restore(); c.strokeStyle = 'rgba(255,255,255,0.3)'; c.strokeRect(x0, y0, S, S);
  }
  return {
    frame, centreTarget,
    launched: () => {
      // Backblast behind the gunner, smoke, the kick.
      launchT = performance.now(); kick = 1;
      const E = lastE, d = dirOf(E.sol.az, E.sol.el), b = W3([E.sol.x - d[0] * 2.5, E.sol.y - d[1] * 2.5, IGLA.eyeM - d[2] * 2.5]), t = E.tick * E.dt;
      puff(b, t, 'flash', 3, 0.25); for (let i = 0; i < 6; i++) puff(b.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random(), (Math.random() - 0.5) * 2)), t, 'dust', 2.5, 3 + Math.random() * 2, 0xb8ab94);
    },
    hitFlash: () => { hitT = performance.now(); },
    dispose: () => {
      ro.disconnect(); document.removeEventListener('pointerlockchange', onLock); removeEventListener('mouseup', mup);
      if (document.pointerLockElement === cv) document.exitPointerLock();
      city?.dispose(); renderer.dispose(); pmrem.dispose(); cv.remove(); hud.remove(); tip.remove();
    },
  };
}
