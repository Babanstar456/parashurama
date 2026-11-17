// Showcase: a self-running, narrated 90-second demo for judges and first-time visitors.
// A scripted operator (who makes realistic mistakes) plays a real mission; captions freeze the action at each
// key moment, then the demo walks through the debrief, the expert ghost and the commander's readiness board.
// Showcase runs are practice runs: never saved to history and never synced to the unit server.
import { SCENARIOS, scenarioCfg } from '@parashurama/engine';
import { app, hooks, on } from './app';
import { $ } from './dom';

interface Step { k: string; title: string; text: string; spot?: string; }
const STEPS: Record<string, Step> = {
  mission: { k: 'mission', title: 'The mission', text: 'A CISF team defends an airport in heavy rain. Rain hides radar blips and blurs the camera, and the sky is full of birds and our own aircraft.', spot: '#radarWrap' },
  detect: { k: 'detect', title: 'Detect', text: 'A blip appears on the radar. The operator starts a track on it; the clock for a decision is now running.', spot: '#contactsPanel' },
  identify: { k: 'identify', title: 'Identify', text: 'Clues arrive one by one: radar, friendly check, radio signal, behaviour, camera. The operator must say what it is, and how sure they are.', spot: '#cluePanel' },
  defeat: { k: 'defeat', title: 'Decide and defeat', text: 'Only weapons in reach are live. A radio-controlled drone is best stopped by jamming its link, and in a city the gun is a bad choice.', spot: '#defStep' },
  view3d: { k: 'view3d', title: 'The same drill in 3D', text: 'The live drill as a 3D battlespace, WebXR-ready (headset trial next). It only shows what the sensors see, so it never gives the answer away.', spot: '#view3d' },
  debrief: { k: 'debrief', title: 'Learn from every drill', text: 'The debrief scores every decision against doctrine, and shows the three biggest point losses with the clue that was missed.', spot: '#lessonsCard' },
  ghost: { k: 'ghost', title: 'Against the expert ghost', text: 'The drill tape replays the same seed with a perfect "expert ghost", so the trainee sees exactly where they were slower or wrong.', spot: '#tapeCard' },
  unit: { k: 'unit', title: 'For commanders', text: 'Every drill updates each soldier\'s skill model. Commanders see who is ready for tonight: night, swarm, faulty sensors or bad weather.', spot: '#tabUnit' },
};
const ORDER = ['mission', 'detect', 'identify', 'defeat', 'view3d', 'debrief', 'ghost', 'unit'];
const READ_MS = 5200, FREEZE_MS = 2200, SLOW = 1.4, FAST = 3.4, VIEW3D_MS = 13000;

let running = false, shown: string[] = [], queue: string[] = [], lastShow = 0, freezeUntil = 0, timer = 0, learnAt = 0;

function el(): HTMLElement {
  let d = $('#showcase');
  if (!d) { d = document.createElement('div'); d.id = 'showcase'; d.setAttribute('role', 'status'); d.setAttribute('aria-live', 'polite'); document.body.appendChild(d); }
  return d;
}
function spot(sel?: string) {
  document.querySelectorAll('.scSpot').forEach((n) => n.classList.remove('scSpot'));
  if (sel) document.querySelector(sel)?.classList.add('scSpot');
}
function render(k: string) {
  const s = STEPS[k], i = ORDER.indexOf(k);
  el().innerHTML = `<div class="scCap"><div class="scTop"><span class="scLive">● Demo</span><span class="scStep">${i + 1} / ${ORDER.length} · ${s.title}</span>
    <button class="scExit" id="scExit">Exit demo <kbd>Esc</kbd></button></div>
    <p>${s.text}</p><div class="scDots">${ORDER.map((_, j) => `<i class="${j < i ? 'done' : j === i ? 'on' : ''}"></i>`).join('')}</div></div>`;
  el().classList.add('on'); el().classList.toggle('low', app.phase !== 'fight'); // debrief: caption at the bottom, off the cards
  $('#scExit').onclick = () => stopShowcase(true);
  spot(s.spot);
}
function show(k: string) {
  if (shown.includes(k) || queue.includes(k)) return;
  queue.push(k);
}
/** Show the next queued caption once the current one has been on screen long enough to read. */
function pump() {
  const now = performance.now();
  if (!queue.length || now - lastShow < READ_MS) return;
  const k = queue.shift()!; shown.push(k); lastShow = now; render(k);
  if (app.phase === 'fight') freezeUntil = now + FREEZE_MS; // freeze-frame so the viewer can read
  if (k === 'view3d') { const v = $('#view3d'); if (v) { if (v.classList.contains('min')) ($('#v3min') as HTMLElement).click(); if (!v.classList.contains('big')) ($('#v3big') as HTMLElement).click(); setTimeout(() => { if (running && !$('#v3follow').classList.contains('on')) ($('#v3follow') as HTMLElement).click(); }, 1800); } }
  if (k === 'ghost') $('#tapeCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (k === 'debrief') window.scrollTo({ top: 0, behavior: 'smooth' });
  if (k === 'unit') { app.renderUnit(); ($('.learnTabs [data-t=unit]') as HTMLElement).click(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
}

function tick() {
  if (!running) return;
  const L = app.L, sec = L ? L.tick * 0.1 : 0, now = performance.now();
  if (app.phase === 'fight') {
    // safety net: keep the story moving even if an event never happens
    if (sec > 12) show('detect');
    if (sec > 20) show('identify');
    if (sec > 28) show('defeat');
    if (shown.includes('defeat')) show('view3d');
    // pacing: normal speed while a caption is being read, fast-forward in between
    app.live.speed = now - lastShow < READ_MS ? SLOW : FAST;
    // after the 3D moment has played, end the drill and move to the debrief (or skip 3D if there is no WebGL)
    const no3d = !$('#view3d');
    // end on simulated progress (enough threats handled for a meaningful debrief), with a time cap for slow machines
    const since3d = now - lastShow;
    if (shown.includes('view3d') && since3d > READ_MS + 1500 && (sec >= 42 || since3d > VIEW3D_MS + 8000 || no3d)) app.finishDrill();
    if (sec > 110) app.finishDrill();
  } else if (app.phase === 'learn') {
    if (!learnAt) { learnAt = now; queue = queue.filter((k) => ['debrief', 'ghost', 'unit'].includes(k)); }
    show('debrief'); if (shown.includes('debrief')) show('ghost'); if (shown.includes('ghost')) show('unit');
    if (shown.includes('unit') && now - lastShow > READ_MS + 1500) { finale(); return; }
  }
  pump();
}

function finale() {
  running = false; clearInterval(timer); spot();
  el().classList.remove('low');
  el().innerHTML = `<div class="scCap scEnd"><div class="scTop"><span class="scLive">✓ Demo complete</span></div>
    <h3>That's PARASHURAMA.</h3><p>Learn, fight, improve: counter-drone training on any laptop, even offline. Every decision explained, every score verified.</p>
    <div class="scBtns"><button class="scGo" id="scTry">Try it yourself</button><button id="scAgain">Watch again</button></div></div>`;
  $('#scTry').onclick = () => { stopShowcase(false); app.renderBrief(); app.setPhase('brief'); hooks.showHome?.(); };
  $('#scAgain').onclick = () => { stopShowcase(false); startShowcase(); };
}

export function startShowcase() {
  const s = SCENARIOS.find((x) => x.id === 'airport-rain') ?? SCENARIOS[0];
  running = true; shown = []; queue = []; lastShow = 0; freezeUntil = 0; learnAt = 0;
  if (!app.DB.tourDone) { app.DB.tourDone = true; app.saveDB(); }
  app.startDrill(false, { mode: 'showcase', template: s.name, cfg: scenarioCfg(s, app.plan.cfg.drill), spawns: s.spawns, auto: true, speed: 1.8 });
  document.getElementById('toast')?.classList.remove('on');
  show('mission'); lastShow = -1e9; pump();
  clearInterval(timer); timer = window.setInterval(tick, 120);
}
export function stopShowcase(home: boolean) {
  running = false; clearInterval(timer); spot(); el().classList.remove('on');
  if (home) { if (app.phase === 'fight') { app.live.auto = false; app.renderBrief(); app.setPhase('brief'); } hooks.showHome?.(); }
}

export function initShowcase() {
  hooks.showcase = startShowcase;
  // freeze-frame while a new caption is being read
  hooks.blockers.push(() => running && performance.now() < freezeUntil);
  on('act', (a: any) => {
    if (!running) return;
    if (a.k === 'track') { show('detect'); if (app.live.sel == null) app.select(a.c.id); }
    if (a.k === 'id') { show('identify'); app.select(a.c.id); }
    if (a.k === 'eng' && a.eff !== 'hold') { show('defeat'); app.select(a.c.id); }
  });
  // the demo owns the keyboard: only Esc (exit) gets through
  document.addEventListener('keydown', (e) => { if (!running && !$('#showcase')?.classList.contains('on')) return; e.stopPropagation(); if (e.key === 'Escape') stopShowcase(true); }, true);
  if (new URLSearchParams(location.search).has('demo')) setTimeout(startShowcase, 600);
}
