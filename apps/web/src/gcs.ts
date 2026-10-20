// UAV ground-control-station strike drill (extension beyond the counter-drone PS; training model only).
// Pre-flight → plan → take-off clearance → corridor transit → find and lock the target → CLEAR TO ENGAGE → Master Arm →
// release on the impact point → assessment → SAFE → return → recover. 2D canvas only, so it runs on any laptop.
import {
  angDiff, ccip, createGcs, defaultGcsCfg, dirOf, gcsDone, gcsMaxTicks, getConfig, gimbalGround, gunsOf, losOf, mulberry, runGcs, scoreGcs, stepGcs, uavAI,
  type GcsCfg, type UavAction, type UavEngine, type Vec3,
} from '@parashurama/engine';
import { app } from './app';
import { $ } from './dom';
import { toast } from './toast';

const KEY = 'parashurama.uavH';
interface UavRecord { n: number; date: number; cfg: GcsCfg; total: number; miss: number | null; rules: string[]; }
let H: UavRecord[] = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } })();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(H.slice(-100))); } catch { /* storage blocked */ } };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
interface Live { E: UavEngine; log: UavAction[]; q: UavAction[]; acc: number; last: number; raf: number; done: boolean; fast: boolean; keys: Set<string>; rates: [number, number]; seen: number; radio: { t: number; who: string; text: string }[]; track: Vec3[]; onExit: () => void; }
let L: Live | null = null;

function say(text: string) { if ((app.DB.settings?.sound ?? 'sound') === 'voice' && 'speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(text.toLowerCase())); }
const MSG: Record<string, [string, string]> = {
  reqTakeoff: ['GCS', 'RANGE CONTROL, REQUEST TAKE-OFF'], takeoffCleared: ['RANGE', 'CLEARED FOR TAKE-OFF'], takeoff: ['GCS', 'TAKING OFF'],
  takeoffNoClearance: ['SYS', 'Took off WITHOUT clearance'], airborne: ['GCS', 'AIRBORNE, ON CORRIDOR'], direct: ['SYS', 'Direct to the IP: off the planned corridor'],
  onStation: ['GCS', 'ON STATION, SEARCHING'], lockFail: ['SYS', 'Nothing under the crosshair to lock'], reqEngage: ['GCS', 'TARGET LOCKED, REQUEST CLEAR TO ENGAGE'],
  engageCleared: ['MC', 'CLEAR TO ENGAGE'], engageDenied: ['MC', 'NEGATIVE, THAT IS NOT THE TARGET'], armOn: ['GCS', 'MASTER ARM ON'], armSafe: ['GCS', 'MASTER ARM SAFE'],
  run: ['GCS', 'IN ON THE ATTACK RUN'], releaseInterlock: ['SYS', 'Release blocked: Master Arm is SAFE'], release: ['GCS', 'RELEASE, RELEASE'],
  releaseNoClearance: ['SYS', 'Released WITHOUT clearance'], breach: ['SYS', 'GEOFENCE: outside the safe corridor'], rth: ['GCS', 'RETURNING ON INBOUND CORRIDOR'],
  landed: ['GCS', 'LANDED'], recover: ['GND', 'AIRCRAFT RECOVERED'], payloadClear: ['GND', 'PAYLOAD CLEAR, NO HUNG ORDNANCE'], plan: ['GCS', 'MISSION PLAN LOADED'],
};
function pump() {
  const E = L!.E;
  for (; L!.seen < E.ev.length; L!.seen++) {
    const e = E.ev[L!.seen];
    let m = MSG[e.k];
    if (e.k === 'check') m = ['SYS', `Checked: ${E.U.checks.find((c) => c.id === e.text)?.label ?? e.text}`];
    if (e.k === 'lock') m = ['GCS', `LOCKED: ${e.text}`];
    if (e.k === 'impact') m = ['SYS', `Impact (${e.text})`];
    if (e.k === 'bda') m = ['GCS', `BDA: TARGET ${e.text === 'hit' ? 'DESTROYED' : 'MISSED'}`];
    if (!m) continue;
    L!.radio.push({ t: e.tick * E.dt, who: m[0], text: m[1] }); if (m[0] !== 'SYS') say(m[1]);
  }
}

interface Step { label: string; done: boolean; check?: string; key?: string; }
function steps(E: UavEngine): Step[] {
  const s: Step[] = E.U.checks.map((c) => ({ label: c.label, done: E.checks[c.id] != null, check: c.id }));
  s.push({ label: 'Load the mission plan', done: E.planTick != null, key: 'P' });
  s.push({ label: 'Request take-off clearance', done: E.reqTakeoffTick != null, key: 'T' });
  s.push({ label: 'Take off (after clearance)', done: E.takeoffTick != null, key: 'O' });
  s.push({ label: 'Transit inside the corridor', done: E.loiterTick != null });
  s.push({ label: 'Find and lock the target', done: E.lock?.id === E.target.id, key: 'L' });
  s.push({ label: 'Request CLEAR TO ENGAGE', done: E.engageClearTick != null, key: 'C' });
  s.push({ label: 'Master Arm ON', done: E.armTick != null && (E.engageClearTick == null || E.armTick >= E.engageClearTick), key: 'M' });
  s.push({ label: 'Attack run; steer the impact point onto the target', done: E.phase === 'run' || !!E.release, key: 'R' });
  s.push({ label: 'Release on the impact point', done: !!E.release, key: 'Space' });
  s.push({ label: 'Master Arm SAFE', done: E.safeTick != null, key: 'M' });
  s.push({ label: 'Report the damage assessment', done: !!E.bda, key: 'H/N' });
  s.push({ label: 'Return on the inbound corridor', done: E.rthTick != null, key: 'B' });
  s.push({ label: 'Land', done: E.landedTick != null });
  s.push({ label: 'Recover the aircraft', done: E.recoverTick != null, key: 'V' });
  s.push({ label: 'Payload clearance', done: E.payloadClearTick != null, key: 'Y' });
  return s;
}

export function startGcs(onExit: () => void, cfg?: GcsCfg) {
  stopGcs();
  const r = mulberry(4111 + H.length * 97);
  const c = cfg ?? defaultGcsCfg({ seed: 50000 + Math.floor(r() * 1e6), time: r() < 0.3 ? 'night' : 'day', difficulty: 3, met: { tempC: Math.round(15 + r() * 25), pressureHpa: Math.round(990 + r() * 25), wind: [Math.round((r() - 0.5) * 14), Math.round((r() - 0.5) * 14), 0], latitudeDeg: 26 } });
  const E = createGcs(c);
  L = { E, log: [], q: [], acc: 0, last: performance.now(), raf: 0, done: false, fast: false, keys: new Set(), rates: [0, 0], seen: 0, radio: [], track: [], onExit };
  const U = E.U;
  $('#gunApp').innerHTML = `<div class="gnDrill gcs">
    <div class="gnBar"><b>UAV GCS · STRIKE DRILL</b><span>${esc(U.label)} · ${esc(U.munition.label)} · wind ${Math.round(Math.hypot(c.met.wind[0], c.met.wind[1]))} m/s · ${c.time}</span>
      <span class="gnMeasures">Extension: own-UAV strike procedure (training model)</span><span class="gnClock num" id="ucClock">0:00</span><button class="smallBtn" id="ucFast">Fast ×4 <kbd>F</kbd></button><button class="smallBtn" id="ucQuit">End drill</button></div>
    <div class="gnMain ucMain"><canvas id="ucMap" aria-label="Mission map"></canvas><canvas id="ucEo" aria-label="Gimbal camera"></canvas></div>
    <aside class="gnSide"><div class="gnBox" id="ucProc"></div><div class="gnBox" id="ucPanel"></div><div class="gnBox gnRadioBox"><h4>Radio net</h4><div class="gnRadio" id="ucRadio"></div></div></aside></div>`;
  $('#ucQuit').onclick = () => finish(true);
  $('#ucFast').onclick = () => { if (L) L.fast = !L.fast; };
  L.radio.push({ t: 0, who: 'SYS', text: 'You are the UAV operator. Pre-flight checks first; nothing is released without CLEAR TO ENGAGE.' });
  panel(); L.raf = requestAnimationFrame(loop);
}
export function stopGcs() { if (L) cancelAnimationFrame(L.raf); L = null; }
const act = (a: Omit<UavAction, 'tick'>) => { if (L && !L.done) L.q.push({ ...a, tick: L.E.tick } as UavAction); };
function tick() {
  const E = L!.E, k = L!.keys;
  const az = (k.has('arrowright') || k.has('d') ? 1 : 0) - (k.has('arrowleft') || k.has('a') ? 1 : 0), el = (k.has('arrowup') || k.has('w') ? 1 : 0) - (k.has('arrowdown') || k.has('s') ? 1 : 0);
  const f = k.has('shift') ? 0.2 : 1;
  if (az * f !== L!.rates[0] || el * f !== L!.rates[1]) { L!.rates = [az * f, el * f]; act({ k: 'gimbal', az: az * f, el: el * f }); }
  const acts = L!.q.splice(0).map((a) => ({ ...a, tick: E.tick }));
  L!.log.push(...acts); stepGcs(E, acts); pump();
  if (E.tick % 10 === 0 && E.p[2] > 5) L!.track.push([E.p[0], E.p[1], 0]);
  if (gcsDone(E)) finish(false);
}
function loop(now: number) {
  if (!L || L.done) return;
  L.acc += Math.min(250, now - L.last) * (L.fast ? 4 : 1); L.last = now;
  let n = 0; while (L.acc >= 100 && n++ < 20 && !L.done) { L.acc -= 100; tick(); }
  if (L.done) return;
  drawMap(); drawEo(); if (L.E.tick % 3 === 0) panel();
  L.raf = requestAnimationFrame(loop);
}
function panel() {
  const E = L!.E, st = steps(E), at = st.findIndex((x) => !x.done);
  ($('#ucClock') as HTMLElement).textContent = `${Math.floor(E.tick / 600)}:${String(Math.floor(E.tick / 10) % 60).padStart(2, '0')}`;
  $('#ucProc').innerHTML = `<h4>Procedure <small>${st.filter((x) => x.done).length}/${st.length}</small></h4><ol class="gnProc">${st.map((x, i) =>
    `<li class="${x.done ? 'ok' : i === at ? 'now' : ''}"><i>${x.done ? '✓' : i === at ? '▶' : '○'}</i>${!x.done && x.check ? `<button data-check="${x.check}">${esc(x.label)}</button>` : `<span>${esc(x.label)}</span>`}${x.key && !x.done ? `<kbd>${x.key}</kbd>` : ''}</li>`).join('')}</ol>`;
  document.querySelectorAll<HTMLElement>('#ucProc [data-check]').forEach((b) => (b.onclick = () => act({ k: 'check', item: b.dataset.check! })));
  const c = E.arm ? ccip(E) : null;
  $('#ucPanel').innerHTML = `<div class="gnStat">
      <span>${E.phase.toUpperCase()}</span><span>Alt ${Math.round(E.p[2])} m</span><span>Hdg ${String(Math.round(E.hdg)).padStart(3, '0')}°</span>
      <span class="${E.arm ? 'hot' : 'ok'}">MASTER ARM ${E.arm ? 'ON' : 'SAFE'}</span><span class="${E.engageClearTick != null ? 'ok' : 'warn'}">${E.engageClearTick != null ? 'Cleared to engage' : 'Not cleared'}</span>
      ${E.lock ? `<span>Locked: ${esc(E.objs.find((o) => o.id === E.lock!.id)!.label)}</span>` : ''}${E.outside ? '<span class="hot">OUTSIDE CORRIDOR</span>' : ''}
      ${c ? `<span>Impact point ${Math.round(Math.hypot(c.p[0] - E.target.p[0], c.p[1] - E.target.p[1]))} m from lock</span>` : ''}${E.phase === 'run' ? `<span>Steer ${E.steer > 0 ? '+' : ''}${E.steer.toFixed(0)}°</span>` : ''}</div>
    <div class="gnKeys">
      <button data-u="plan">Mission plan<kbd>P</kbd></button><button data-u="reqTakeoff">Request take-off<kbd>T</kbd></button><button data-u="takeoff">Take off<kbd>O</kbd></button>
      <button data-u="direct">Direct to IP<kbd>D</kbd></button><button data-u="lock">Lock<kbd>L</kbd></button><button data-u="reqEngage">Request clearance<kbd>C</kbd></button>
      <button data-u="arm">Master Arm<kbd>M</kbd></button><button data-u="run">Attack run<kbd>R</kbd></button><button data-u="release" class="fire">RELEASE<kbd>Space</kbd></button>
      <button data-u="hit">BDA: destroyed<kbd>H</kbd></button><button data-u="miss">BDA: missed<kbd>N</kbd></button><button data-u="rth">Return<kbd>B</kbd></button>
      <button data-u="recover">Recover<kbd>V</kbd></button><button data-u="payloadClear">Payload clear<kbd>Y</kbd></button></div>
    <p class="gnHelp">Camera: arrows / WASD (Shift = fine). Steer the run: Q / E. Fast-forward the transit with F.</p>`;
  document.querySelectorAll<HTMLElement>('#ucPanel [data-u]').forEach((b) => (b.onclick = () => key(b.dataset.u!)));
  const rr = $('#ucRadio') as HTMLElement;
  rr.innerHTML = L!.radio.slice(-14).map((r) => `<p class="${r.who === 'SYS' ? 'SYS' : r.who === 'GCS' ? '' : 'GUN'}"><i>${Math.floor(r.t / 60)}:${String(Math.floor(r.t) % 60).padStart(2, '0')}</i><b>${r.who}</b>${esc(r.text)}</p>`).join('');
  rr.scrollTop = rr.scrollHeight;
}
function key(k: string) {
  const E = L?.E; if (!E) return;
  if (k === 'arm') act({ k: 'arm', on: !E.arm });
  else if (k === 'hit' || k === 'miss') act({ k: 'bda', out: k });
  else if (k === 'steerL' || k === 'steerR') act({ k: 'steer', deg: E.steer + (k === 'steerR' ? 1 : -1) });
  else act({ k } as any);
}
const fit = (cv: HTMLCanvasElement) => { const w = cv.clientWidth * devicePixelRatio, h = cv.clientHeight * devicePixelRatio; if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } return cv.getContext('2d')!; };
function drawMap() {
  const cv = $('#ucMap') as HTMLCanvasElement, ctx = fit(cv), E = L!.E, dp = devicePixelRatio, W = cv.width, Hh = cv.height;
  const pts = [...E.out, E.target.p, [0, 0, 0] as Vec3], xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2, span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + 3400;
  const s = Math.min(W, Hh) / span, P = (p: Vec3) => [W / 2 + (p[0] - cx) * s, Hh / 2 - (p[1] - cy) * s];
  ctx.fillStyle = E.cfg.time === 'night' ? '#0A1410' : '#1B2A22'; ctx.fillRect(0, 0, W, Hh);
  // Safe corridor (band) and target area.
  ctx.strokeStyle = 'rgba(63,167,150,0.25)'; ctx.lineWidth = E.U.corridorHalfWidthM * 2 * s; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath(); [...E.out, E.target.p].forEach((p, i) => { const [x, y] = P(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
  ctx.fillStyle = 'rgba(63,167,150,0.12)'; ctx.beginPath(); const [tx, ty] = P(E.target.p); ctx.arc(tx, ty, 1300 * s, 0, 7); ctx.fill();
  // Village (no-fly) on the direct line.
  const [vx, vy] = P(E.village); ctx.fillStyle = 'rgba(255,92,97,0.22)'; ctx.beginPath(); ctx.arc(vx, vy, 450 * s, 0, 7); ctx.fill();
  ctx.fillStyle = '#FF9EA1'; ctx.font = `${11 * dp}px Barlow Condensed, sans-serif`; ctx.fillText('VILLAGE · NO-FLY', vx - 40 * dp, vy);
  // Waypoints, base, IP, objects.
  ctx.fillStyle = '#F2C94C'; for (const [i, p] of E.out.entries()) { const [x, y] = P(p); ctx.fillRect(x - 3 * dp, y - 3 * dp, 6 * dp, 6 * dp); ctx.fillText(i === 0 ? 'BASE' : i === E.out.length - 1 ? 'IP' : `WP${i}`, x + 6 * dp, y - 6 * dp); }
  for (const o of E.objs) { const [x, y] = P(o.p); ctx.fillStyle = o.kind === 'target' ? '#FF5C61' : o.kind === 'civil' ? '#6FCF97' : '#8A9DAE'; ctx.beginPath(); ctx.arc(x, y, 3.5 * dp, 0, 7); ctx.fill(); }
  // Track, UAV, impact point.
  ctx.strokeStyle = 'rgba(93,169,255,0.6)'; ctx.lineWidth = 1.5 * dp; ctx.beginPath(); L!.track.forEach((p, i) => { const [x, y] = P(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
  const [ux, uy] = P(E.p), h = (E.hdg * Math.PI) / 180;
  ctx.save(); ctx.translate(ux, uy); ctx.rotate(h); ctx.fillStyle = '#5DA9FF'; ctx.beginPath(); ctx.moveTo(0, -9 * dp); ctx.lineTo(6 * dp, 7 * dp); ctx.lineTo(-6 * dp, 7 * dp); ctx.closePath(); ctx.fill(); ctx.restore();
  const g = gimbalGround(E); if (g) { const [gx, gy] = P(g); ctx.strokeStyle = 'rgba(242,201,76,0.6)'; ctx.setLineDash([3 * dp, 3 * dp]); ctx.beginPath(); ctx.moveTo(ux, uy); ctx.lineTo(gx, gy); ctx.stroke(); ctx.setLineDash([]); }
  const c = E.arm && !E.release ? ccip(E) : null; if (c) { const [x, y] = P(c.p); ctx.strokeStyle = '#FF8A4C'; ctx.lineWidth = 2 * dp; ctx.beginPath(); ctx.arc(x, y, 5 * dp, 0, 7); ctx.stroke(); }
  if (E.impact && E.tick >= E.impact.tick) { const [x, y] = P(E.impact.p); ctx.fillStyle = 'rgba(255,170,60,0.85)'; ctx.beginPath(); ctx.arc(x, y, 6 * dp, 0, 7); ctx.fill(); }
}
/** Gimbal camera looking down from the UAV: objects placed by their angle from the boresight. */
function drawEo() {
  const cv = $('#ucEo') as HTMLCanvasElement, ctx = fit(cv), E = L!.E, dp = devicePixelRatio, W = cv.width, Hh = cv.height, night = E.cfg.time === 'night';
  const fov = E.U.gimbalFovDeg, px = W / fov;
  ctx.fillStyle = night ? '#0B1F12' : '#55624A'; ctx.fillRect(0, 0, W, Hh);
  const proj = (p: Vec3) => { const l = losOf([p[0] - E.p[0], p[1] - E.p[1], p[2] - E.p[2]]); return [W / 2 + angDiff(l.az, E.gim.az) * Math.cos((l.el * Math.PI) / 180) * px, Hh / 2 - (l.el - E.gim.el) * px, l.range]; };
  // Ground texture: fields seeded by position so they do not swim.
  const gg = gimbalGround(E);
  if (gg && E.p[2] > 5) {
    for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) {
      const q: Vec3 = [Math.round(gg[0] / 40) * 40 + i * 40, Math.round(gg[1] / 40) * 40 + j * 40, 0], h = ((q[0] * 73856093) ^ (q[1] * 19349663)) >>> 0;
      const [x, y] = proj(q); ctx.fillStyle = night ? `rgba(120,255,150,${0.04 + (h % 5) * 0.015})` : `rgba(${100 + (h % 40)},${110 + (h % 30)},${80 + (h % 25)},0.5)`;
      ctx.fillRect(x - 12 * dp, y - 12 * dp, 24 * dp, 24 * dp);
    }
  }
  if (E.p[2] > 5) for (const o of E.objs) {
    const [x, y, r] = proj(o.p); if (x < -30 || x > W + 30 || y < -30 || y > Hh + 30) continue;
    const sz = Math.max(3 * dp, (o.kind === 'hut' ? 6 : 4) / r * 57.3 * px);
    ctx.fillStyle = night ? '#D8FFE0' : o.kind === 'civil' ? '#D9D2B8' : '#2A2F2A';
    ctx.fillRect(x - sz, y - sz * 0.6, sz * 2, sz * 1.2);
    if (E.lock?.id === o.id) { ctx.strokeStyle = '#F2C94C'; ctx.lineWidth = 2 * dp; ctx.strokeRect(x - sz - 8 * dp, y - sz - 8 * dp, 2 * sz + 16 * dp, 2 * sz + 16 * dp); }
  }
  const c = E.arm && !E.release ? ccip(E) : null;
  if (c) { const [x, y] = proj(c.p); ctx.strokeStyle = '#FF8A4C'; ctx.lineWidth = 2 * dp; ctx.beginPath(); ctx.arc(x, y, 9 * dp, 0, 7); ctx.moveTo(x, y + 9 * dp); ctx.lineTo(x, y + 26 * dp); ctx.stroke(); ctx.fillStyle = '#FF8A4C'; ctx.fillText('CCIP', x + 12 * dp, y); }
  if (E.impact && E.tick >= E.impact.tick && E.tick < E.impact.tick + 60) { const [x, y] = proj(E.impact.p); ctx.fillStyle = 'rgba(255,170,60,0.8)'; ctx.beginPath(); ctx.arc(x, y, (8 + (E.tick - E.impact.tick)) * dp, 0, 7); ctx.fill(); }
  const k = night ? 'rgba(170,255,180,0.9)' : 'rgba(240,240,230,0.9)';
  ctx.strokeStyle = k; ctx.lineWidth = 1.2 * dp; ctx.beginPath(); ctx.moveTo(W / 2 - 40 * dp, Hh / 2); ctx.lineTo(W / 2 - 6 * dp, Hh / 2); ctx.moveTo(W / 2 + 6 * dp, Hh / 2); ctx.lineTo(W / 2 + 40 * dp, Hh / 2);
  ctx.moveTo(W / 2, Hh / 2 - 40 * dp); ctx.lineTo(W / 2, Hh / 2 - 6 * dp); ctx.moveTo(W / 2, Hh / 2 + 6 * dp); ctx.lineTo(W / 2, Hh / 2 + 40 * dp); ctx.stroke();
  ctx.fillStyle = k; ctx.font = `${12 * dp}px Barlow Condensed, sans-serif`;
  ctx.fillText(`EO/IR ${night ? 'THERMAL' : 'DAY'} · AZ ${Math.round(E.gim.az)} EL ${Math.round(E.gim.el)}${gg ? ` · LRF ${Math.round(Math.hypot(gg[0] - E.p[0], gg[1] - E.p[1], E.p[2]))} m` : ''}`, 8 * dp, 16 * dp);
  ctx.fillStyle = E.arm ? '#FF5C61' : '#6FCF97'; ctx.fillText(E.arm ? 'MASTER ARM ON' : 'SAFE', W - 100 * dp, 16 * dp);
  void dirOf;
}
function finish(quit: boolean) {
  if (!L || L.done) return;
  L.done = true; cancelAnimationFrame(L.raf);
  const E = L.E, sc = scoreGcs(E), R = runGcs(E.cfg, { actions: L.log, until: E.tick }), verified = scoreGcs(R).total === sc.total;
  const ghost = scoreGcs(runGcs(E.cfg, { policy: uavAI, stopWhenDone: true }));
  if (!quit || E.tick > 100) { H.push({ n: H.length + 1, date: Date.now(), cfg: E.cfg, total: sc.total, miss: E.impact?.miss ?? null, rules: sc.rules }); save(); }
  const RULES = getConfig().doctrine.rules, pass = sc.total >= getConfig().training.certification.passMark, onExit = L.onExit;
  $('#gunApp').innerHTML = `<div class="gnDebrief"><div class="gnHead"><h2>UAV strike drill · debrief</h2><button class="smallBtn" id="ucBack">All drills</button><button class="smallBtn solid" id="ucNext">Next mission →</button></div>
    <div class="gnScore ${pass ? 'pass' : 'fail'}"><b class="num">${sc.total}</b><span>${pass ? 'PASS' : 'NOT YET'}</span><small>${verified ? 'Verified: same score when re-run from the log.' : 'Re-run did not match.'} Expert on the same mission: ${ghost.total}.</small></div>
    <div class="gnMetrics"><span><b>${E.impact ? `${E.impact.miss.toFixed(1)} m` : '—'}</b>miss distance</span><span><b>${E.impact?.hit ? 'Yes' : 'No'}</b>target destroyed</span><span><b>${E.breaches.length}</b>corridor breaches</span><span class="${sc.metrics.violations ? 'bad' : ''}"><b>${sc.metrics.violations}</b>procedure violations</span></div>
    <h4>Points by rule</h4><table class="gnParts">${[...sc.parts, ...sc.deductions.filter((d) => d.pts)].map((p) => `<tr class="${p.max ? '' : 'ded'}"><td><span class="rule" title="${esc(RULES[p.rule] ?? '')}">${p.rule}</span></td><td>${esc(p.label)}</td><td class="num">${p.max ? `${p.pts}/${p.max}` : p.pts}</td><td>${p.why.map(esc).join('<br>')}</td></tr>`).join('')}</table></div>`;
  $('#ucBack').onclick = onExit; $('#ucNext').onclick = () => startGcs(onExit);
}
export function initGcs() {
  document.addEventListener('keydown', (e) => {
    if (!L || L.done || !document.querySelector('.gnDrill.gcs')) return;
    e.stopImmediatePropagation(); // the gun console's own key handler must not see these
    const k = e.key.toLowerCase();
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'w', 'a', 's', 'd', 'shift'].includes(k)) { e.preventDefault(); L.keys.add(k); return; }
    if (e.repeat) return;
    const map: Record<string, string> = { p: 'plan', t: 'reqTakeoff', o: 'takeoff', l: 'lock', c: 'reqEngage', m: 'arm', r: 'run', ' ': 'release', h: 'hit', n: 'miss', b: 'rth', v: 'recover', y: 'payloadClear', q: 'steerL', e: 'steerR' };
    if (k === 'f') { L.fast = !L.fast; return; }
    if (k === 'escape') { finish(true); return; }
    if (map[k]) { e.preventDefault(); key(map[k]); }
  }, true);
  document.addEventListener('keyup', (e) => { if (L && !L.done) { L.keys.delete(e.key.toLowerCase()); e.stopImmediatePropagation(); } }, true);
  (window as any).PARA_UAV = { start: startGcs, autoplay: () => { if (!L) return; const E = L.E; while (!L.done && E.tick < gcsMaxTicks(E)) { L.q.push(...uavAI(E)); tick(); } if (!L.done) finish(false); }, history: () => H };
  void gunsOf; void toast;
}
