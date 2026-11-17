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
import { lang, onLang, setLang, t } from './i18n';

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
    <p class="homeTag">${t('Train every soldier to stop hostile drones.')}<br><span>${t('On any laptop. Even offline.')}</span></p>
    <div class="hpRow">
      <button class="hpPlay" id="hcPlay" aria-label="Play"><i aria-hidden="true">▶</i><b>${t('Play')}</b></button>
      <button class="hpPlay hpLearn" id="hcLearn" aria-label="Learn: open the classroom"><i aria-hidden="true">📖</i><b>${t('Learn')}</b></button>
    </div>
    <button class="hpDemo" id="hcDemo">${t('or watch the 90-second demo')}</button>
  </div>
  <button class="hpLang" id="hcLang" lang="${lang === 'hi' ? 'en' : 'hi'}">${lang === 'hi' ? 'English' : 'हिंदी'}</button>
  <div class="homeFoot"><span>Team Dhwanik_TH06</span><span>${t('Training values only, not equipment specifications')}</span></div>`;
}

interface Card { id: string; tag?: string; tagCls?: string; title: string; body: string; foot?: string; done?: boolean; data?: string; /** Never "Start here" (a menu, not a drill). */ menu?: boolean; }
const cardHtml = (x: Card, here: boolean) => `<button class="hb ${here ? 'here' : ''}" id="${x.id}"${x.data ?? ''}>
  <small>${x.tag ? `<i class="hbTag ${x.tagCls ?? ''}">${x.tag}</i>` : ''}${here ? `<i class="hbHere">${t('Start here')}</i>` : x.done ? `<i class="hbDone">${t('Done ✓')}</i>` : ''}</small>
  <b>${x.title}</b><span>${x.body}</span><em>${x.foot ?? t('Start →')}</em></button>`;
const crumbs = (s: Stage) => ({ play: '', pick: t('Play'), ground: `${t('Play')} › ${t('On Ground')}`, radar: `${t('Play')} › ${t('Radar')}`, missions: `${t('Play')} › ${t('Radar')} › ${t('Real-world missions')}` })[s];

function screen(title: string, lead: string, cards: Card[], extra = '', startHere = true, cls = ''): string {
  const here = startHere ? cards.find((x) => !x.done && !x.menu)?.id : undefined;
  return `
  <canvas id="homeFx" aria-hidden="true"></canvas>
  <div class="homeMenu">
    <div class="hmTop"><button class="hmBack" id="hcBack">${t('← Back')}</button><div><small class="hmCrumb">${crumbs(stage)}</small><h2>${title}</h2></div></div>
    <p class="hmLead">${lead}</p>
    <div class="hmBig ${cls || (cards.length === 2 ? 'two' : '')}">${cards.map((x) => cardHtml(x, x.id === here)).join('')}</div>
    ${extra}
  </div>`;
}

function stageHtml(): string {
  const local = (k: string): any[] => { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const field = local('parashurama.gunH').filter((r) => r?.game === 'field'), pats = local('parashurama.patrolH');
  const byGun = (g: string) => field.filter((r) => r?.cfg?.gun === g), lastOf = (a: any[]) => (a.length ? t('Last score {n} · Start →', { n: a[a.length - 1].total }) : undefined);
  const aca = new Set<number>(app.DB.academy?.done ?? []), m = mastery(app.DB.H);
  const weakest = (['night', 'swarm', 'degraded', 'weather'] as const).reduce((a, b) => (m[a] <= m[b] ? a : b));
  const weakName = t({ night: 'night drills', swarm: 'swarm attacks', degraded: 'faulty sensors', weather: 'bad weather' }[weakest]);
  if (stage === 'pick') {
    const certified = Object.values(m).filter((v) => v >= CERT.certifiedMastery).length;
    return screen(t('Where do you train?'), t('Pick one. You can come back and try the others at any time.'), [
      { id: 'hcGround', tag: t('Guns'), title: t('On Ground'), body: t('Sit at the gun: L-70, Shilka or ZU-23-2. Spot the drone in the sky, identify it and fire. You can also drive the Shilka through a town.'), foot: t('Choose a gun →') },
      { id: 'hcRadarTrack', tag: t('Screen'), title: t('Radar'), body: t('Work the radar screen: spot drones, decide friend or foe, and pick the right way to stop each one. Lessons with a coach first.'), foot: t('Choose →') },
      { id: 'hcMultiCard', tag: t('Online'), tagCls: 'medium', title: t('Multiplayer'), body: t('Play with others: host a room or join with a code. Crew the gun together, or fight for the top score in Radar or On Ground.'), foot: t('Host or join →') },
    ], `<p class="hmSmall">${t('For commanders and instructors:')} <button class="hmLink" id="hcUnit">${t('Unit readiness')}</button> ${t('(you: {a} of {b} skills certified)', { a: certified, b: Object.keys(m).length })} · <button class="hmLink" id="hcLectures">${t('Classroom library')}</button></p>`, false, 'two three');
  }
  if (stage === 'ground') {
    return screen(t('Choose a gun'), t('Start with an easy one: day, clear sky, sensors working. Each drill takes a few minutes, and every decision is explained at the end.'), [
      { id: 'hcL70', tag: t('Easy'), tagCls: 'easy', title: t('L-70 gun'), body: t('The thermal sight and laser rangefinder track the drone and work out the lead for you.'), done: byGun('l70').length > 0, foot: lastOf(byGun('l70')) },
      { id: 'hcZsu', tag: t('Easy'), tagCls: 'easy', title: t('Shilka (ZSU-23-4)'), body: t('The radar locks on and shows you where to aim (the lead). You report, identify and fire.'), done: byGun('zsu234').length > 0, foot: lastOf(byGun('zsu234')) },
      { id: 'hcPatrol', tag: t('Medium'), tagCls: 'medium', title: t('Urban patrol'), body: t('Drive the Shilka through an old town. Drones pop up over the rooftops: engage only hostiles.'), done: pats.length > 0, foot: lastOf(pats) },
      { id: 'hcRaid', tag: t('Hard'), tagCls: 'hard', title: t('Saturation raid'), body: t('14 Shahed-type drones in waves. The outer layer stops some; you take the leakers, closest first, before they reach you.'), foot: t('Start →'), menu: true },
      { id: 'hcZu', tag: t('Medium'), tagCls: 'medium', title: t('ZU-23-2 (upgraded)'), body: t('The upgraded twin gun: day camera, thermal imager, laser rangefinder and a digital fire-control computer. Old manual sight under More gun drills.'), done: byGun('zu23m').length > 0, foot: lastOf(byGun('zu23m')) },
    ], `<p class="hmSmall"><button class="hmLink" id="hcGun">${t('More gun drills')}</button>${t(': crew the gun on orders, run the control room, reload practice, UAV strike.')}</p>`);
  }
  if (stage === 'radar') {
    const lesson = LESSONS.find((l) => !aca.has(l.n));
    return screen(t('Radar training'), t('New to it? Start with the lessons: a coach explains every clue and when not to fire.'), [
      { id: 'hcAcademy', tag: t('{a} of {b} lessons', { a: aca.size, b: LESSONS.length }), tagCls: 'easy', title: t('Learn with a coach'), body: lesson ? t('Four short lessons, about 10 minutes in all. Next: {t}.', { t: lesson.title }) : t('All lessons done. Replay any lesson.'), done: !lesson, foot: lesson ? t('Start lesson {n} →', { n: lesson.n }) : t('Replay →') },
      { id: 'hcRecog', tag: t('3 minutes'), tagCls: 'easy', title: t('Recognition trainer'), body: t('Name the drone in 1.5 seconds: by eye, binoculars, TV or thermal, day and night. The types you mix up come back more often.'), foot: t('Start →'), menu: true },
      { id: 'hcDrill', tag: t('Scored'), title: t('Quick radar drill'), body: t('A short drill the enemy AI builds around your weakest skill: <strong>{w}</strong>.', { w: weakName }), done: app.DB.H.length > 0 },
      { id: 'hcMissions', tag: t('Scored'), title: t('Real-world missions'), body: t('Defend a real kind of site: an air base at night, a border post in fog, an airport in rain, a forward post in a dust storm.'), foot: t('Choose a mission →'), menu: true },
    ]);
  }
  // missions
  return screen(t('Choose a mission'), t('Each one is a fixed, scored raid on a real kind of site.'),
    SCENARIOS.map((sc, i) => ({ id: `hcMission${i}`, data: ` data-hm="${i}"`, tag: `${t(sc.cfg.time === 'night' ? 'Night' : 'Day')} · ${WEATHER_LABEL[sc.cfg.weather ?? 'clear']}`, title: sc.name, body: sc.agency })), '', false);
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
  on('hcLang', () => { setLang(lang === 'hi' ? 'en' : 'hi'); render(); });
  on('hcLearn', go(() => hooks.openLectures?.()));
  on('hcDemo', () => { closeHome(); hooks.showcase?.(); });
  on('hcMultiCard', () => hooks.openMultiplayer?.());
  on('hcBack', to(UP[stage]));
  on('hcGround', to('ground'));
  on('hcRadarTrack', to('radar'));
  on('hcMissions', to('missions'));
  on('hcL70', go(() => hooks.openGun?.('field', { gun: 'l70', easy: true })));
  on('hcZsu', go(() => hooks.openGun?.('field', { gun: 'zsu234', easy: true })));
  on('hcZu', go(() => hooks.openGun?.('field', { gun: 'zu23m', easy: true })));
  on('hcPatrol', go(() => hooks.openGun?.('patrol')));
  on('hcRaid', go(() => hooks.openGun?.('field', { gun: 'zsu234', raid: 14 })));
  on('hcGun', go(() => hooks.openGun?.()));
  on('hcAcademy', () => { const done = new Set<number>(app.DB.academy?.done ?? []); const nx = LESSONS.find((l) => !done.has(l.n)) ?? LESSONS[0]; closeHome(); markTourSeen(); startLesson(nx.n); });
  on('hcDrill', quickDrill);
  on('hcRecog', go(() => void import('./recog').then((m) => m.openRecog(() => showHome()))));
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
  const skip = q.has('nohome') || q.has('instructor') || q.has('demo') || q.has('gun') || q.has('recog');
  if (q.has('recog')) void import('./recog').then((m) => m.openRecog(() => showHome()));
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
