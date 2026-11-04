// Mission Hub: the front door, one decision at a time. It opens on one PLAY button. Play asks only "On Ground or
// Radar?". On Ground then offers the guns, easiest first (L-70 and Shilka on easy settings, the urban patrol, the
// harder ZU-23-2); Radar offers the coached lessons, a quick drill and the real-world missions. Back (or Esc) steps up
// one level. Readiness and the classroom library are small links on the first choice.
import { SCENARIOS, WEATHER_LABEL, mulberry, mastery } from '@parashurama/engine';
import { app, hooks } from './app';
import { $, $$ } from './dom';
import { LESSONS, startLesson } from './academy';
import { startScenario } from './scenarios';
import { CERT } from './cfg';

let open = false, raf = 0;
type Stage = 'play' | 'pick' | 'ground' | 'radar' | 'missions';
/** Where the hub is (this session): after Play, the Home button returns to the choices, not to the Play screen. */
let stage: Stage = 'play';
const UP: Record<Stage, Stage> = { play: 'play', pick: 'play', ground: 'pick', radar: 'pick', missions: 'radar' };
const local = (k: string): any[] => { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

function quickDrill() { closeHome(); app.renderBrief(); app.setPhase('brief'); if (!app.DB.tourDone) app.startTour(0); }

function playHtml(): string {
  return `
  <canvas id="homeFx" aria-hidden="true"></canvas>
  <div class="homePlay">
    <div class="homeKicker">Smart India Hackathon 2026 · SIH26247 · Ministry of Defence</div>
    <h1 class="homeTitle">PARASHURAMA</h1>
    <p class="homeTag">Train every soldier to stop hostile drones.<br><span>On any laptop. Even offline.</span></p>
    <div class="hpMulti"><i>MULTIPLAYER</i><span>Crew drills over your unit network · push-to-talk radio</span></div>
    <div class="hpRow">
      <button class="hpPlay" id="hcPlay" aria-label="Play"><i aria-hidden="true">▶</i><b>Play</b></button>
      <button class="hpPlay hpLearn" id="hcLearn" aria-label="Learn: open the classroom"><i aria-hidden="true">📖</i><b>Learn</b></button>
    </div>
    <button class="hpDemo" id="hcDemo">or watch the 90-second demo</button>
  </div>
  <div class="homeFoot"><span>Team Dhwanik_TH06</span><span>Training values only, not equipment specifications</span></div>`;
}

interface Card { id: string; tag?: string; tagCls?: string; title: string; body: string; foot?: string; done?: boolean; data?: string; /** Never "Start here" (a menu, not a drill). */ menu?: boolean; }
const cardHtml = (x: Card, here: boolean) => `<button class="hb ${here ? 'here' : ''}" id="${x.id}"${x.data ?? ''}>
  <small>${x.tag ? `<i class="hbTag ${x.tagCls ?? ''}">${x.tag}</i>` : ''}${here ? '<i class="hbHere">Start here</i>' : x.done ? '<i class="hbDone">Done ✓</i>' : ''}</small>
  <b>${x.title}</b><span>${x.body}</span><em>${x.foot ?? 'Start →'}</em></button>`;
const crumbs: Record<Stage, string> = { play: '', pick: 'Play', ground: 'Play › On Ground', radar: 'Play › Radar', missions: 'Play › Radar › Real-world missions' };

function screen(title: string, lead: string, cards: Card[], extra = '', startHere = true): string {
  const here = startHere ? cards.find((x) => !x.done && !x.menu)?.id : undefined;
  return `
  <canvas id="homeFx" aria-hidden="true"></canvas>
  <div class="homeMenu">
    <div class="hmTop"><button class="hmBack" id="hcBack">← Back</button><div><small class="hmCrumb">${crumbs[stage]}</small><h2>${title}</h2></div></div>
    <p class="hmLead">${lead}</p>
    <div class="hmBig ${cards.length === 2 ? 'two' : ''}">${cards.map((x) => cardHtml(x, x.id === here)).join('')}</div>
    ${extra}
  </div>`;
}

function stageHtml(): string {
  const local = (k: string): any[] => { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const field = local('parashurama.gunH').filter((r) => r?.game === 'field'), pats = local('parashurama.patrolH');
  const byGun = (g: string) => field.filter((r) => r?.cfg?.gun === g), lastOf = (a: any[]) => (a.length ? `Last score ${a[a.length - 1].total} · Start →` : undefined);
  const aca = new Set<number>(app.DB.academy?.done ?? []), m = mastery(app.DB.H);
  const weakest = (['night', 'swarm', 'degraded', 'weather'] as const).reduce((a, b) => (m[a] <= m[b] ? a : b));
  const weakName = { night: 'night drills', swarm: 'swarm attacks', degraded: 'faulty sensors', weather: 'bad weather' }[weakest];
  if (stage === 'pick') {
    const certified = Object.values(m).filter((v) => v >= CERT.certifiedMastery).length;
    return screen('Where do you train?', 'Pick one. You can come back and try the other at any time.', [
      { id: 'hcGround', tag: 'Guns', title: 'On Ground', body: 'Sit at the gun: L-70, Shilka or ZU-23-2. Spot the drone in the sky, identify it and fire. You can also drive the Shilka through a town.', foot: 'Choose a gun →' },
      { id: 'hcRadarTrack', tag: 'Screen', title: 'Radar', body: 'Work the radar screen: spot drones, decide friend or foe, and pick the right way to stop each one. Lessons with a coach first.', foot: 'Choose →' },
    ], `<p class="hmSmall">For commanders and instructors: <button class="hmLink" id="hcUnit">Unit readiness</button> (you: ${certified} of ${Object.keys(m).length} skills certified) · <button class="hmLink" id="hcLectures">Classroom library</button></p>`, false);
  }
  if (stage === 'ground') {
    return screen('Choose a gun', 'Start with an easy one: day, clear sky, sensors working. Each drill takes a few minutes, and every decision is explained at the end.', [
      { id: 'hcL70', tag: 'Easy', tagCls: 'easy', title: 'L-70 gun', body: 'The thermal sight and laser rangefinder track the drone and work out the lead for you.', done: byGun('l70').length > 0, foot: lastOf(byGun('l70')) },
      { id: 'hcZsu', tag: 'Easy', tagCls: 'easy', title: 'Shilka (ZSU-23-4)', body: 'The radar locks on and lays the four guns for you. You report, identify and fire.', done: byGun('zsu234').length > 0, foot: lastOf(byGun('zsu234')) },
      { id: 'hcPatrol', tag: 'Medium', tagCls: 'medium', title: 'Urban patrol', body: 'Drive the Shilka through an old town. Drones pop up over the rooftops: engage only hostiles.', done: pats.length > 0, foot: lastOf(pats) },
      { id: 'hcZu', tag: 'Medium', tagCls: 'medium', title: 'ZU-23-2 (upgraded)', body: 'The upgraded twin gun: day camera, thermal imager, laser rangefinder and a digital fire-control computer. Old manual sight under More gun drills.', done: byGun('zu23m').length > 0, foot: lastOf(byGun('zu23m')) },
    ], '<p class="hmSmall"><button class="hmLink" id="hcGun">More gun drills</button>: crew the gun on orders, run the control room, reload practice, UAV strike.</p>');
  }
  if (stage === 'radar') {
    const lesson = LESSONS.find((l) => !aca.has(l.n));
    return screen('Radar training', 'New to it? Start with the lessons: a coach explains every clue and when not to fire.', [
      { id: 'hcAcademy', tag: `${aca.size} of ${LESSONS.length} lessons`, tagCls: 'easy', title: 'Learn with a coach', body: lesson ? `Four short lessons, about 10 minutes in all. Next: ${lesson.title}.` : 'All lessons done. Replay any lesson.', done: !lesson, foot: lesson ? `Start lesson ${lesson.n} →` : 'Replay →' },
      { id: 'hcDrill', tag: 'Scored', title: 'Quick radar drill', body: `A short drill the enemy AI builds around your weakest skill: <strong>${weakName}</strong>.`, done: app.DB.H.length > 0 },
      { id: 'hcMissions', tag: 'Scored', title: 'Real-world missions', body: 'Defend a real kind of site: an air base at night, a border post in fog, an airport in rain, a forward post in a dust storm.', foot: 'Choose a mission →', menu: true },
    ]);
  }
  // missions
  return screen('Choose a mission', 'Each one is a fixed, scored raid on a real kind of site.',
    SCENARIOS.map((sc, i) => ({ id: `hcMission${i}`, data: ` data-hm="${i}"`, tag: `${sc.cfg.time === 'night' ? 'Night' : 'Day'} · ${WEATHER_LABEL[sc.cfg.weather ?? 'clear']}`, title: sc.name, body: sc.agency })), '', false);
}

/** Animated radar backdrop: a slow sweep with drifting contacts. Purely decorative. */
function fx() {
  const cv = $('#homeFx') as HTMLCanvasElement; if (!cv) return;
  const ctx = cv.getContext('2d')!;
  const r = mulberry(7);
  const dots = Array.from({ length: 14 }, () => ({ a: r() * 6.283, d: 0.25 + r() * 0.7, s: 0.0006 + r() * 0.0012, k: r() < 0.3 ? 1 : 0 }));
  let t0 = performance.now();
  const draw = (t: number) => {
    if (!open) return;
    const W = (cv.width = cv.clientWidth * devicePixelRatio), H = (cv.height = cv.clientHeight * devicePixelRatio);
    const R = Math.min(W, H) * 0.62, cx = W * 0.78, cy = H * 0.55, sw = ((t - t0) / 4000) * 6.283;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(63,167,150,0.16)'; ctx.lineWidth = 1.2 * devicePixelRatio;
    for (let k = 1; k <= 4; k++) { ctx.beginPath(); ctx.arc(cx, cy, (R * k) / 4, 0, 7); ctx.stroke(); }
    for (let k = 0; k < 12; k++) { const a = (k / 12) * 6.283; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke(); }
    for (let i = 0; i < 40; i++) {
      const a = sw - i * 0.012; ctx.strokeStyle = `rgba(63,167,150,${0.28 * (1 - i / 40)})`; ctx.lineWidth = 3 * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
    }
    for (const d of dots) {
      d.d -= d.s * (d.k ? 1 : 0.3); if (d.d < 0.08) d.d = 0.95;
      const x = cx + Math.cos(d.a) * d.d * R, y = cy + Math.sin(d.a) * d.d * R;
      const since = ((sw - d.a) % 6.283 + 6.283) % 6.283, glow = Math.max(0.15, 1 - since / 4);
      ctx.fillStyle = d.k ? `rgba(229,72,77,${glow})` : `rgba(242,201,76,${glow})`;
      ctx.beginPath(); ctx.arc(x, y, 4.5 * devicePixelRatio, 0, 7); ctx.fill();
    }
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);
}

export function showHome() {
  if (app.phase === 'fight') return;
  let el = $('#home');
  if (!el) { el = document.createElement('div'); el.id = 'home'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'PARASHURAMA home'); document.body.appendChild(el); }
  el.classList.add('on'); open = true; document.body.classList.add('homeOn');
  if (stage !== 'play') stage = 'pick';
  render();
}
function render() {
  const el = $('#home'); if (!el) return;
  cancelAnimationFrame(raf);
  el.classList.toggle('menu', stage !== 'play');
  el.innerHTML = stage === 'play' ? playHtml() : stageHtml();
  const to = (st: Stage) => () => { stage = st; render(); };
  const go = (f: () => void) => () => { closeHome(); markTourSeen(); f(); };
  const on = (id: string, f: () => void) => { const b = document.getElementById(id); if (b) b.onclick = f; };
  on('hcPlay', to('pick'));
  on('hcLearn', go(() => hooks.openLectures?.()));
  on('hcDemo', () => { closeHome(); hooks.showcase?.(); });
  on('hcBack', to(UP[stage]));
  on('hcGround', to('ground'));
  on('hcRadarTrack', to('radar'));
  on('hcMissions', to('missions'));
  on('hcL70', go(() => hooks.openGun?.('field', { gun: 'l70', easy: true })));
  on('hcZsu', go(() => hooks.openGun?.('field', { gun: 'zsu234', easy: true })));
  on('hcZu', go(() => hooks.openGun?.('field', { gun: 'zu23m', easy: true })));
  on('hcPatrol', go(() => hooks.openGun?.('patrol')));
  on('hcGun', go(() => hooks.openGun?.()));
  on('hcAcademy', () => { const done = new Set<number>(app.DB.academy?.done ?? []); const nx = LESSONS.find((l) => !done.has(l.n)) ?? LESSONS[0]; closeHome(); markTourSeen(); startLesson(nx.n); });
  on('hcDrill', quickDrill);
  $$('[data-hm]').forEach((b: any) => (b.onclick = go(() => startScenario(SCENARIOS[+b.dataset.hm]))));
  on('hcLectures', go(() => hooks.openLectures?.()));
  on('hcUnit', go(() => { app.renderUnit(); app.setPhase('learn'); ($('.learnTabs [data-t=unit]') as HTMLElement).click(); }));
  fx();
  ((stage === 'play' ? $('#hcPlay') : document.querySelector('#home .hb.here') ?? document.querySelector('#home .hb')) as HTMLElement)?.focus({ preventScroll: true });
  el.scrollTop = 0;
}
/** Choosing a guided path (Academy, mission, board) means the general tour is not needed now. */
function markTourSeen() { if (!app.DB.tourDone) { app.DB.tourDone = true; app.saveDB(); } }
export function closeHome() {
  open = false; cancelAnimationFrame(raf); $('#home')?.classList.remove('on'); document.body.classList.remove('homeOn');
}

export function initHome() {
  hooks.showHome = showHome;
  const q = new URLSearchParams(location.search);
  // Home screen; skipped for deep links (instructor panel, tests).
  const skip = q.has('nohome') || q.has('instructor') || q.has('demo') || q.has('gun');
  hooks.holdTour = !skip || q.has('gun');
  // Home button in the header (hidden during a drill so a drill is never abandoned by accident)
  const hb = document.createElement('button'); hb.className = 'topBtn'; hb.id = 'homeBtn'; hb.textContent = 'Home';
  hb.onclick = () => showHome(); $('#helpBtn').before(hb);
  // Block the app's keyboard shortcuts (e.g. Enter = begin drill) while the hub is open.
  document.addEventListener('keydown', (e) => {
    if (!open) return;
    e.stopPropagation(); // default actions (Enter/Space on a focused card, Tab focus) still work
    if (e.key === 'Escape' && stage !== 'play') { stage = UP[stage]; render(); }
  }, true);
  if (!skip) showHome();
}
export const homeOpen = () => open;
