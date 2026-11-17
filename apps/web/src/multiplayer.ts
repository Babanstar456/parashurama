// Multiplayer room with a room code (no unit server needed: works on the public website). One player hosts and gets a
// 5-letter code; others join with it (or with the ?room=CODE link). The host chooses each round:
//  - Crew drill (co-op): one player in the Control Room, one on the gun; an empty seat is played by the AI. The host's
//    browser runs the drill clock exactly as the unit server does, and every client mirrors it from the same actions.
//  - Score fight: everyone plays the identical drill (same seed and config), Radar or On Ground (3D field firing).
//    Live scores show in the corner; at the end the host re-runs each player's decision log to check the score.
// Transport: p2p.ts (direct, encrypted WebRTC data channels; a public broker only for the handshake).
import {
  controlRoomAI, createGun, gunCrewAI, gunDone, planGun, runGun, runSim, runTotal, scoreControl, scoreField, scoreGround, scoreRun, stepGun, SCENARIOS, scenarioCfg, gunsOf, getConfig,
  type GunAction, type GunDrillConfig, type GunEngine,
} from '@parashurama/engine';
import { app, hooks, on } from './app';
import { TYPES } from './cfg';
import { $ } from './dom';
import { toast } from './toast';
import { HostNet, joinNet, p2pSupported, cleanCode, type Wire } from './p2p';
import { openCrew, openGunWith, fieldCfg, isGunOpen, closeGun, type CrewLink } from './gun';
import { closeHome } from './home';

type Kind = 'crew' | 'radar' | 'field';
interface LiveScore { score: number; kills: number; hostiles: number; }
interface Final { total: number; kills: number; hostiles: number; verified: boolean | null; quit: boolean; expert: number | null; }
interface Player { id: string; name: string; host: boolean; live?: LiveScore | null; final?: Final | null; }
interface Round { n: number; kind: Kind; label: string; cfg: any; spawns: any; ids: string[]; done: boolean; }

const NAME_KEY = 'parashurama.callsign';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const rand31 = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return 1 + (a[0] % (2 ** 31 - 2)); };

let serverMode = false;
let role: 'host' | 'guest' | null = null, code = '', myId = '', myName = '';
let net: HostNet | null = null, wire: Wire | null = null, leaving = false, busy = false;
let players: Player[] = [], round: Round | null = null, seenRound = 0, playing = false, finalSent = false, liveTimer = 0, roundN = 0;
let crew: CrewHost | null = null, crewFns: Record<string, ((d: any) => void)[]> | null = null;

function callsign(): string {
  let s = ''; try { s = localStorage.getItem(NAME_KEY) ?? ''; } catch { /* private mode */ }
  return s || `Gunner ${Math.floor(Math.random() * 900 + 100)}`;
}
const saveName = (s: string) => { myName = s.trim().slice(0, 24) || callsign(); try { localStorage.setItem(NAME_KEY, myName); } catch { /* ignore */ } };

// ---------------- host side ----------------
const KINDS = new Set(['order', 'check', 'uxo', 'rstep', 'ack', 'post', 'kill', 'load', 'safety', 'lay', 'slew', 'trig', 'sight', 'lock', 'clear', 'barrel', 'unload', 'report', 'spot', 'ident']);
/** Keep only well-formed fields of a guest's action (the seat is always the sender's own). */
function cleanAct(x: any): any | null {
  if (!x || !KINDS.has(x.k)) return null;
  const a: any = { k: x.k };
  for (const f of ['cid', 'az', 'el', 'spd', 'crs', 'rng', 'n', 'i']) if (typeof x[f] === 'number' && Number.isFinite(x[f])) a[f] = x[f];
  for (const f of ['o', 'out', 'item', 'cls']) if (typeof x[f] === 'string' && x[f].length <= 32) a[f] = x[f];
  if (x.on != null) a.on = !!x.on;
  return a;
}
/** The crew drill clock, run in the host's browser (same rules as the unit server's crew rooms). */
class CrewHost {
  seats: { cr: { id: string; name: string } | null; gun: { id: string; name: string } | null } = { cr: null, gun: null };
  E: GunEngine | null = null; log: GunAction[] = []; queue: GunAction[] = []; timer = 0; ended = false; scores: Record<string, number> | null = null;
  constructor(public cfg: GunDrillConfig) {}
  view() { const s = this.seats; return { code, cfg: this.cfg, seats: { cr: s.cr?.name ?? null, gun: s.gun?.name ?? null }, ids: { cr: s.cr?.id ?? null, gun: s.gun?.id ?? null }, started: !!this.E, ended: this.ended, tick: this.E?.tick ?? 0, scores: this.scores }; }
  seatOf(id: string) { return this.seats.cr?.id === id ? 'cr' : this.seats.gun?.id === id ? 'gun' : null; }
  handle(from: string, m: any) {
    const p = players.find((x) => x.id === from); if (!p) return;
    if (m.t === 'hello') { crewTo(from, 'state', this.view()); if (this.E) crewTo(from, 'sync', { log: this.log, tick: this.E.tick }); return; }
    if (m.t === 'resync') { if (this.E) crewTo(from, 'sync', { log: this.log, tick: this.E.tick }); return; }
    if (m.t === 'seat') {
      const s = m.seat; if (!['cr', 'gun', 'none'].includes(s)) return;
      if (this.ended) return errTo(from, 'This crew drill has ended');
      if (s !== 'none' && this.seats[s as 'cr'] && this.seats[s as 'cr']!.id !== from) return errTo(from, 'That seat is taken');
      if (this.seats.cr?.id === from) this.seats.cr = null; if (this.seats.gun?.id === from) this.seats.gun = null;
      if (s !== 'none') this.seats[s as 'cr'] = { id: from, name: p.name };
      crewAll('state', this.view()); return;
    }
    if (m.t === 'start') {
      if (!this.seatOf(from)) return errTo(from, 'Take a seat first');
      if (this.E) return;
      this.E = createGun(this.cfg);
      this.timer = window.setInterval(() => { try { this.tick(); } catch (e) { console.error(e); } }, Math.round(this.E.dt * 1000));
      crewAll('state', this.view()); return;
    }
    if (m.t === 'act') {
      const seat = this.seatOf(from); if (!seat || !this.E || this.ended || !Array.isArray(m.acts)) return;
      for (const x of m.acts.slice(0, 40)) { const a = cleanAct(x); if (a) this.queue.push({ ...a, tick: 0, seat }); }
      return;
    }
    if (m.t === 'end') { if (this.seatOf(from) || from === myId) this.end(); }
  }
  tick() {
    const E = this.E!; if (this.ended) return;
    const mine = this.queue.splice(0).map((a) => ({ ...a, tick: E.tick }));
    const ai = [...(this.seats.cr ? [] : controlRoomAI(E)), ...(this.seats.gun ? [] : gunCrewAI(E, { ackSec: 1.5 }))].map((a) => ({ ...a, tick: E.tick }));
    const acts = [...mine, ...ai];
    this.log.push(...acts); stepGun(E, acts);
    crewAll('tick', { t: E.tick - 1, a: acts });
    if (gunDone(E)) this.end();
  }
  end() {
    if (this.ended) return;
    this.ended = true; clearInterval(this.timer);
    if (this.E) { this.scores = { cr: scoreControl(this.E).total, gun: scoreGround(this.E).total }; crewAll('end', { scores: this.scores, tick: this.E.tick }); }
    crewAll('state', this.view());
    if (round?.kind === 'crew') { round.done = true; broadcastRoom(); }
  }
  leave(id: string) { if (this.seats.cr?.id === id) this.seats.cr = null; if (this.seats.gun?.id === id) this.seats.gun = null; crewAll('state', this.view()); }
  stop() { clearInterval(this.timer); }
}
function crewTo(id: string, ev: string, d: unknown) { if (id === myId) deliverCrew(ev, d); else net?.send(id, { t: 'crew', ev, d }); }
function crewAll(ev: string, d: unknown) { net?.broadcast({ t: 'crew', ev, d }); deliverCrew(ev, d); }
function errTo(id: string, msg: string) { if (id === myId) toast(msg); else net?.send(id, { t: 'err', msg }); }

function roomView() { return { code, players, round }; }
function broadcastRoom() { const v = roomView(); net?.broadcast({ t: 'room', d: v }); applyRoom(JSON.parse(JSON.stringify(v))); }

/** Re-run a score-fight log on the host and check the claimed score. */
function verify(r: Round, d: any): boolean | null {
  try {
    const until = Math.max(1, Math.min(40000, Math.floor(+d.endTick || 0)));
    if (r.kind === 'radar' && Array.isArray(d.acts)) return runTotal(scoreRun(runSim(r.cfg, { actions: d.acts, until, spawns: r.spawns || undefined }))) === d.total;
    if (r.kind === 'field' && Array.isArray(d.log)) return scoreField(runGun(r.cfg, { actions: d.log, until })).total === d.total;
  } catch { return false; }
  return null;
}
function checkDone() {
  if (!round || round.done || round.kind === 'crew') return;
  const left = round.ids.filter((id) => players.some((p) => p.id === id && !p.final));
  if (!left.length) round.done = true;
}
function hostHandle(from: string, m: any) {
  if (m.t === 'hello') {
    if (players.some((p) => p.id === from)) return;
    let name = String(m.name ?? 'Guest').replace(/[<>]/g, '').trim().slice(0, 24) || 'Guest';
    for (let i = 2; players.some((p) => p.name === name); i++) name = `${name.replace(/ \d+$/, '')} ${i}`;
    players.push({ id: from, name, host: false });
    net?.send(from, { t: 'welcome', id: from });
    broadcastRoom(); return;
  }
  const p = players.find((x) => x.id === from); if (!p) return;
  if (m.t === 'crew') { crew?.handle(from, m.m ?? {}); return; }
  if (!round || round.kind === 'crew' || !round.ids.includes(from)) return;
  if (m.t === 'live' && !p.final) { const d = m.d ?? {}; p.live = { score: +d.score || 0, kills: +d.kills || 0, hostiles: +d.hostiles || 0 }; broadcastRoom(); return; }
  if (m.t === 'final' && !p.final) {
    const d = m.d ?? {};
    p.final = { total: Math.round(+d.total || 0), kills: +d.kills || 0, hostiles: +d.hostiles || 0, quit: !!d.quit, expert: d.expert == null ? null : +d.expert, verified: verify(round, d) };
    p.live = { score: p.final.total, kills: p.final.kills, hostiles: p.final.hostiles };
    checkDone(); broadcastRoom();
  }
}
function hostLeave(id: string) {
  players = players.filter((p) => p.id !== id); crew?.leave(id); checkDone(); broadcastRoom();
}
const toHost = (m: any) => (role === 'host' ? hostHandle(myId, m) : wire?.send(m));

/** Host: start a new round for everyone in the room. */
function startRound(kind: Kind, opt: string, easy: boolean) {
  if (role !== 'host') return;
  if (round && !round.done && round.kind !== 'crew') { toast('Wait for this round to finish.'); return; }
  crew?.stop(); crew = null;
  let cfg: any, spawns: any = null, label = '';
  if (kind === 'crew') { cfg = { ...planGun([], 'ground').cfg, seed: rand31() }; crew = new CrewHost(cfg); label = `Crew drill · ${gunsOf(getConfig()).guns[cfg.gun]?.short ?? cfg.gun}`; }
  else if (kind === 'radar') {
    const s = opt === 'quick' ? null : SCENARIOS[+opt];
    if (s) { cfg = scenarioCfg(s, app.plan.cfg.drill); spawns = s.spawns; label = `Radar · ${s.name}`; }
    else { cfg = { ...app.plan.cfg, seed: rand31() }; label = 'Radar · quick drill'; }
  } else { cfg = { ...fieldCfg(opt, easy), seed: rand31() }; label = `On Ground · ${gunsOf(getConfig()).guns[opt]?.short ?? opt}${easy ? ' · easy' : ''}`; }
  for (const p of players) { p.live = null; p.final = null; }
  round = { n: ++roundN, kind, label, cfg, spawns, ids: players.map((p) => p.id), done: false };
  broadcastRoom();
}

// ---------------- client side (host and guests) ----------------
function deliverCrew(ev: string, d: unknown) { (crewFns?.[ev] ?? []).forEach((f) => { try { f(d); } catch (e) { console.error(e); } }); }
function crewLink(): CrewLink {
  const fns: Record<string, ((d: any) => void)[]> = {}; crewFns = fns;
  const send = (m: any) => { if (role === 'host') crew?.handle(myId, m); else wire?.send({ t: 'crew', m }); return Promise.resolve(); };
  queueMicrotask(() => void send({ t: 'hello' })); // after the waiting room has registered its handlers
  return { code, via: `room ${code}`, voice: false,
    seatOf: (st) => (st.ids?.cr === myId ? 'cr' : st.ids?.gun === myId ? 'gun' : null),
    on: (ev, f) => { (fns[ev] ??= []).push(f); },
    seat: (x) => send({ t: 'seat', seat: x }), start: () => send({ t: 'start' }), act: (acts) => send({ t: 'act', acts }), end: () => send({ t: 'end' }),
    resync: () => void send({ t: 'resync' }), close: () => { if (crewFns === fns) crewFns = null; } };
}
function applyRoom(v: any) {
  players = v.players ?? []; round = v.round ?? null;
  if (round && round.n !== seenRound) {
    seenRound = round.n;
    if (round.kind === 'crew') { if (!round.done) enterCrew(); }
    else if (round.ids.includes(myId)) countdown(round);
  }
  renderRoom(); renderHud();
}
function enterCrew() {
  closeMp(); closeHome();
  playing = false; openCrew(crewLink());
}
function countdown(r: Round) {
  let n = 3; closeMp();
  const el = document.createElement('div'); el.id = 'mpCount'; document.body.appendChild(el);
  const stepIt = () => {
    if (round?.n !== r.n || !role) { el.remove(); return; }
    if (n > 0) { el.innerHTML = `<small>${esc(r.label)}</small><b>${n}</b><span>Same drill for everyone. Highest score wins.</span>`; n--; setTimeout(stepIt, 1000); return; }
    el.remove(); beginFight(r);
  };
  stepIt();
}
function beginFight(r: Round) {
  playing = true; finalSent = false;
  if (r.kind === 'radar') {
    if (isGunOpen()) closeGun();
    closeHome();
    app.startDrill(false, { mode: 'template', template: `Score fight ${code}`, cfg: r.cfg, spawns: r.spawns || undefined });
  } else { closeHome(); openGunWith('field', r.cfg); }
  clearInterval(liveTimer); liveTimer = window.setInterval(sendLive, 1000);
}
function sendLive() {
  if (!playing || !round || finalSent) return;
  try {
    if (round.kind === 'radar') {
      const L = app.L; if (!L || app.phase !== 'fight') return;
      const hs = L.contacts.filter((c: any) => TYPES[c.type]?.hostile);
      toHost({ t: 'live', d: { score: runTotal(scoreRun(L)), kills: hs.filter((c: any) => c.state === 'neutralised').length, hostiles: hs.length } });
    } else {
      const E = (window as any).PARA_GUN?.engine?.(); if (!E) return;
      const sc = scoreField(E); toHost({ t: 'live', d: { score: sc.total, kills: sc.metrics.kills, hostiles: sc.metrics.hostiles } });
    }
  } catch { /* drill not ready */ }
}
function sendFinal(d: any) {
  if (!playing || finalSent) return;
  finalSent = true; playing = false; clearInterval(liveTimer);
  toHost({ t: 'final', d }); renderHud();
}

// ---------------- connect / leave ----------------
async function host() {
  if (busy) return; busy = true; renderRoom();
  try {
    net = await HostNet.create();
    role = 'host'; code = net.code; myId = 'host'; leaving = false;
    players = [{ id: myId, name: myName, host: true }]; round = null; seenRound = 0; roundN = 0;
    net.onmsg = (id, m) => hostHandle(id, m);
    net.onleave = (id) => hostLeave(id);
    broadcastRoom();
  } catch (e: any) { toast(e.message); }
  busy = false; renderRoom();
}
async function join(c: string) {
  c = cleanCode(c); if (c.length !== 5) { toast('A room code has 5 letters or digits.'); return; }
  if (busy) return; busy = true; renderRoom();
  try {
    const w = await joinNet(c);
    wire = w; role = 'guest'; code = c; leaving = false; seenRound = 0;
    w.onmsg = (m) => {
      if (m.t === 'welcome') myId = m.id;
      else if (m.t === 'room') { if (myId) applyRoom(m.d); }
      else if (m.t === 'crew') deliverCrew(m.ev, m.d);
      else if (m.t === 'err') toast(m.msg);
    };
    w.onclose = () => { if (!leaving) { toast('The room closed: the host left or the connection dropped.'); deliverCrew('error', null); } reset(); };
    w.send({ t: 'hello', name: myName });
    history.replaceState(null, '', `${location.pathname}?room=${c}`);
  } catch (e: any) { toast(e.message, 9000); }
  busy = false; renderRoom();
}
function reset() {
  crew?.stop(); crew = null; crewFns = null; net = null; wire = null; role = null; code = ''; myId = ''; players = []; round = null;
  playing = false; clearInterval(liveTimer);
  if (location.search.includes('room=')) history.replaceState(null, '', location.pathname);
  renderRoom(); renderHud();
}
function leave() {
  leaving = true;
  if (role === 'host') net?.close(); else wire?.close();
  reset();
}

// ---------------- UI ----------------
function openMp() {
  let el = $('#mpApp') as HTMLElement | null;
  if (!el) {
    el = document.createElement('div'); el.id = 'mpApp'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Multiplayer room');
    el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') closeMp(); });
    document.body.appendChild(el);
  }
  closeHome(); el.classList.add('on'); renderRoom();
}
function closeMp() { $('#mpApp')?.classList.remove('on'); }
const mpOpen = () => !!$('#mpApp')?.classList.contains('on');

function resultsTable(r: Round): string {
  const rows = players.filter((p) => r.ids.includes(p.id)).sort((a, b) => (b.final?.total ?? b.live?.score ?? -1) - (a.final?.total ?? a.live?.score ?? -1) || (b.final?.kills ?? 0) - (a.final?.kills ?? 0));
  const expert = players.find((p) => p.final?.expert != null)?.final?.expert;
  return `<table class="mpTable"><tr><th></th><th>Player</th><th>Score</th><th>Hostiles down</th><th>Check</th></tr>${rows.map((p, i) => {
    const f = p.final, s = f ?? p.live;
    const chk = !f ? '<span class="mut">playing…</span>' : f.verified === true ? '<span class="good" title="The host re-ran this decision log and got the same score">✓ re-run matches</span>' : f.verified === false ? '<span class="bad" title="The host re-ran this decision log and got a different score">✗ re-run differs</span>' : '<span class="mut">—</span>';
    return `<tr class="${p.id === myId ? 'me' : ''}"><td>${r.done ? ['🥇', '🥈', '🥉'][i] ?? i + 1 : i + 1}</td><td>${esc(p.name)}${p.id === myId ? ' (you)' : ''}${f?.quit ? ' <small class="bad">ended early</small>' : ''}</td><td class="num"><b>${s ? (f ? f.total : p.live?.score ?? '—') : '—'}</b></td><td class="num">${s ? `${s.kills}/${s.hostiles}` : '—'}</td><td>${chk}</td></tr>`;
  }).join('')}</table>${expert != null ? `<p class="mpNote">Expert ghost on the same drill: <b>${expert}</b>. Scores are training measures, not operational effectiveness.</p>` : ''}`;
}

function renderRoom() {
  const el = $('#mpApp') as HTMLElement | null; if (!el || !el.classList.contains('on')) return;
  const guns = ['l70', 'zsu234', 'zu23m'].filter((k) => gunsOf(getConfig()).guns[k]);
  const head = `<div class="mpTop"><div><small class="hmCrumb">Play › Multiplayer</small><h2>Multiplayer</h2></div><button class="hmBack" id="mpClose">Close</button></div>`;
  if (!role) {
    const blocked = serverMode ? '<p class="mpWarn">This copy runs on the unit server. On the unit LAN, use <b>Gun drills › More › Crew drill over the LAN</b>. Room codes work on the public website.</p>'
      : !p2pSupported() ? '<p class="mpWarn">This browser cannot make peer-to-peer connections. Use a current Chrome, Edge or Firefox.</p>' : '';
    el.innerHTML = `${head}<div class="mpBody">
      <p class="hmLead">Play with others on any computer with internet: one player hosts and gets a room code, the others join with it. Then play a <b>crew drill</b> together (Control Room + gun) or a <b>score fight</b> (everyone plays the same Radar or On Ground drill; highest score wins).</p>
      ${blocked}
      <label class="mpName">Your callsign <input id="mpName" maxlength="24" value="${esc(myName)}" autocomplete="off"></label>
      <div class="mpTwo">
        <div class="mpCard"><h3>Host a room</h3><p>You get a 5-letter code to share. You choose each round.</p><button class="hpPlay mpBtn" id="mpHost" ${blocked || busy ? 'disabled' : ''}>${busy ? 'Connecting…' : 'Host a room'}</button></div>
        <div class="mpCard"><h3>Join a room</h3><p>Type the code from the host.</p><input id="mpCode" class="mpCode" maxlength="5" placeholder="CODE" autocomplete="off" value="${esc(new URLSearchParams(location.search).get('room') ?? '')}"><button class="hpPlay mpBtn" id="mpJoin" ${blocked || busy ? 'disabled' : ''}>${busy ? 'Connecting…' : 'Join'}</button></div>
      </div>
      <p class="mpNote">Players connect directly, browser to browser (encrypted WebRTC). A public signalling service is used only to introduce the two browsers; drill data does not pass through it. Some strict office or military networks block direct connections: a phone hotspot usually works.</p></div>`;
    const nm = $('#mpName') as HTMLInputElement; nm.onchange = () => saveName(nm.value);
    $('#mpHost').onclick = () => { saveName(nm.value); void host(); };
    const cd = $('#mpCode') as HTMLInputElement; cd.oninput = () => { cd.value = cleanCode(cd.value); };
    cd.onkeydown = (e) => { if (e.key === 'Enter') { saveName(nm.value); void join(cd.value); } };
    $('#mpJoin').onclick = () => { saveName(nm.value); void join(cd.value); };
  } else {
    const isHost = role === 'host', link = `${location.origin}${location.pathname}?room=${code}`;
    const r = round, running = r && !r.done && r.kind !== 'crew';
    el.innerHTML = `${head}<div class="mpBody">
      <div class="mpCodeBox"><small>Room code</small><b>${esc(code)}</b><span>${isHost ? 'Share the code or the link. Keep this tab open: your browser hosts the room.' : 'Connected to the host.'}</span>
        <div><button class="smallBtn" id="mpCopy">Copy invite link</button> <button class="smallBtn" id="mpLeave">${isHost ? 'Close the room' : 'Leave the room'}</button></div></div>
      <div class="mpTwo">
        <div class="mpCard"><h3>Players · ${players.length}</h3><ul class="mpPlayers">${players.map((p) => `<li>${esc(p.name)}${p.host ? ' <i>host</i>' : ''}${p.id === myId ? ' <i>you</i>' : ''}</li>`).join('')}</ul>
          ${r ? `<h3>${r.done ? 'Last round' : 'Now playing'} · ${esc(r.label)}</h3>${r.kind === 'crew' ? `<p>Crew drill${r.done ? ' finished: each player sees the crew debrief.' : '.'} <button class="smallBtn" id="mpCrewOpen">Open the crew drill</button></p>` : resultsTable(r)}` : ''}</div>
        <div class="mpCard">${isHost ? `<h3>Start a round</h3>
          <div class="mpRound"><b>Crew drill</b><span>Co-op. One player in the Control Room gives the orders, one crews the gun. Empty seat = AI. Seats are picked next.</span><button class="smallBtn solid" id="mpCrew" ${running ? 'disabled' : ''}>Start crew drill</button></div>
          <div class="mpRound"><b>Score fight · Radar</b><span>Everyone works the same radar drill: spot, identify, defeat.</span>
            <select id="mpRadar"><option value="quick">Quick drill</option>${SCENARIOS.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join('')}</select><button class="smallBtn solid" id="mpFightR" ${running ? 'disabled' : ''}>Start fight</button></div>
          <div class="mpRound"><b>Score fight · On Ground</b><span>Everyone sits at the same gun in the 3D field drill.</span>
            <select id="mpGun">${guns.map((k) => `<option value="${k}">${esc(gunsOf(getConfig()).guns[k].short)}</option>`).join('')}</select><label class="mpChk"><input type="checkbox" id="mpEasy" checked> Easy</label><button class="smallBtn solid" id="mpFightG" ${running ? 'disabled' : ''}>Start fight</button></div>
          ${running ? '<p class="mpNote">A score fight is running. New rounds can start when everyone has finished.</p>' : ''}`
        : `<h3>Waiting for the host</h3><p>The host picks the next round: a crew drill or a score fight in Radar or On Ground. It starts on your screen by itself.</p>`}</div>
      </div></div>`;
    $('#mpCopy').onclick = () => { navigator.clipboard?.writeText(link).then(() => toast('Invite link copied'), () => toast(link, 9000)); };
    $('#mpLeave').onclick = leave;
    const co = document.getElementById('mpCrewOpen'); if (co) co.onclick = () => enterCrew();
    if (isHost) {
      $('#mpCrew').onclick = () => startRound('crew', '', false);
      $('#mpFightR').onclick = () => startRound('radar', ($('#mpRadar') as HTMLSelectElement).value, false);
      $('#mpFightG').onclick = () => startRound('field', ($('#mpGun') as HTMLSelectElement).value, ($('#mpEasy') as HTMLInputElement).checked);
    }
  }
  $('#mpClose').onclick = closeMp;
}

/** Corner panel: live scores during a score fight, results after it, and a way back to the room. */
function renderHud() {
  let el = $('#mpHud') as HTMLElement | null;
  if (!role) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'mpHud'; document.body.appendChild(el); }
  const r = round, fight = r && r.kind !== 'crew' && r.ids.includes(myId);
  if (fight && !mpOpen()) {
    el.className = r!.done ? 'big' : '';
    el.innerHTML = `<div class="mpHudHead"><b>${r!.done ? 'SCORE FIGHT · RESULT' : 'SCORE FIGHT · LIVE'}</b><small>${esc(r!.label)} · room ${esc(code)}</small></div>${resultsTable(r!)}
      ${!r!.done && finalSent ? '<p class="mpNote">Your score is in. Waiting for the others…</p>' : ''}<button class="smallBtn" id="mpHudRoom">Back to the room</button>${r!.done ? ' <button class="smallBtn" id="mpHudHide">Hide</button>' : ''}`;
  } else {
    el.className = 'pill';
    el.innerHTML = `<button class="smallBtn" id="mpHudRoom">Room ${esc(code)} · ${players.length} player${players.length === 1 ? '' : 's'}</button>`;
  }
  const b = el.querySelector('#mpHudRoom') as HTMLElement | null; if (b) b.onclick = () => openMp();
  const h = el.querySelector('#mpHudHide') as HTMLElement | null; if (h) h.onclick = () => { el!.className = 'pill'; el!.innerHTML = `<button class="smallBtn" id="mpHudRoom2">Room ${esc(code)}</button>`; (el!.querySelector('#mpHudRoom2') as HTMLElement).onclick = () => openMp(); };
}

export function initMultiplayer(o: { online: boolean }) {
  serverMode = o.online; myName = callsign();
  hooks.openMultiplayer = openMp;
  // Score-fight results: the radar debrief and the gun debrief both report here.
  on('finish', (R: any) => {
    if (!playing || round?.kind !== 'radar') return;
    const hs = R.E.contacts.filter((c: any) => TYPES[c.type]?.hostile);
    sendFinal({ total: R.total, acts: R.acts, endTick: R.endTick, kills: hs.filter((c: any) => c.state === 'neutralised').length, hostiles: hs.length, expert: R.totalX, quit: false });
  });
  hooks.gunFinished = (f: any) => {
    if (!playing || round?.kind !== 'field' || f.crew) return;
    sendFinal({ total: f.total, log: f.log, endTick: f.endTick, kills: f.metrics.kills, hostiles: f.metrics.hostiles, expert: f.expert, quit: f.quit });
  };
  addEventListener('beforeunload', (e) => { if (role === 'host' && players.length > 1) { e.preventDefault(); e.returnValue = ''; } });
  const q = new URLSearchParams(location.search).get('room');
  if (q && !serverMode) { openMp(); if (cleanCode(q).length === 5) void join(q); }
}
