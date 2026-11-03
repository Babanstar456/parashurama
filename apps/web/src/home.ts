// Mission Hub: the front door. It opens on a clean screen with one PLAY button; the choices come after Play, and only
// a few at first: the easiest L-70 and Shilka drills lead, then the urban patrol and radar training. Everything else
// (ZU-23-2, all gun drills, lessons, missions, readiness, library) waits behind "More options".
import { SCENARIOS, WEATHER_LABEL, mulberry, mastery } from '@parashurama/engine';
import { app, hooks } from './app';
import { $, $$ } from './dom';
import { LESSONS, startLesson } from './academy';
import { startScenario } from './scenarios';
import { CERT } from './cfg';

let open = false, raf = 0;
/** This session: Play was pressed (the Home button then returns to the choices), and "More options" was opened. */
let played = false, moreOpen = false;
const WX_ICON: Record<string, string> = { clear: '☀', rain: '☔', fog: '🌫', dust: '🌪' };
const local = (k: string): any[] => { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

function quickDrill() { closeHome(); app.renderBrief(); app.setPhase('brief'); if (!app.DB.tourDone) app.startTour(0); }
function radarTraining() {
  const done = new Set<number>(app.DB.academy?.done ?? []), lesson = LESSONS.find((l) => !done.has(l.n));
  if (lesson) { closeHome(); markTourSeen(); startLesson(lesson.n); } else quickDrill();
}

function playHtml(): string {
  return `
  <canvas id="homeFx" aria-hidden="true"></canvas>
  <div class="homePlay">
    <div class="homeKicker">Smart India Hackathon 2026 · SIH26247 · Ministry of Defence</div>
    <h1 class="homeTitle">PARASHURAMA</h1>
    <p class="homeTag">Train every soldier to stop hostile drones.<br><span>On any laptop. Even offline.</span></p>
    <button class="hpPlay" id="hcPlay" aria-label="Play"><i aria-hidden="true">▶</i><b>Play</b></button>
    <button class="hpDemo" id="hcDemo">or watch the 90-second demo</button>
  </div>
  <div class="homeFoot"><span>Team Dhwanik_TH06</span><span>Training values only, not equipment specifications</span></div>`;
}

function menuHtml(): string {
  const field = local('parashurama.gunH').filter((r) => r?.game === 'field'), pats = local('parashurama.patrolH');
  const byGun = (g: string) => field.filter((r) => r?.cfg?.gun === g);
  const l70 = byGun('l70'), zsu = byGun('zsu234'), aca = new Set<number>(app.DB.academy?.done ?? []);
  const radarDone = aca.size >= LESSONS.length || app.DB.H.length > 0;
  const items = [
    { id: 'hcL70', tag: 'Easy', title: 'L-70 gun', body: 'The thermal sight and laser rangefinder track the drone and work out the lead for you. Day, clear sky.', done: l70.length, last: l70[l70.length - 1]?.total },
    { id: 'hcZsu', tag: 'Easy', title: 'Shilka (ZSU-23-4)', body: 'The radar locks on and lays the four guns for you. You report, identify and fire. Day, clear sky.', done: zsu.length, last: zsu[zsu.length - 1]?.total },
    { id: 'hcPatrol', tag: 'Medium', title: 'Urban patrol', body: 'Drive the Shilka through an old town. Drones pop up over the rooftops: engage only hostiles.', done: pats.length, last: pats[pats.length - 1]?.total },
    { id: 'hcRadar', tag: 'Radar', title: 'Radar training', body: aca.size < LESSONS.length ? 'Short lessons with a coach, then scored drills on the radar screen.' : 'A scored radar drill built around your weakest skill.', done: radarDone ? 1 : 0, last: undefined as number | undefined },
  ];
  const here = items.find((x) => !x.done)?.id;
  const m = mastery(app.DB.H), certified = Object.values(m).filter((v) => v >= CERT.certifiedMastery).length;
  const weakest = (['night', 'swarm', 'degraded', 'weather'] as const).reduce((a, b) => (m[a] <= m[b] ? a : b));
  const weakName = { night: 'night drills', swarm: 'swarm attacks', degraded: 'faulty sensors', weather: 'bad weather' }[weakest];
  return `
  <canvas id="homeFx" aria-hidden="true"></canvas>
  <div class="homeMenu">
    <div class="hmTop"><button class="hmBack" id="hcBack">← Back</button><h2>Choose a drill</h2></div>
    <p class="hmLead">Start with an easy one. Each takes a few minutes, and every decision is explained at the end.</p>
    <div class="hmBig">${items.map((x) => `<button class="hb ${x.id === here ? 'here' : ''}" id="${x.id}">
        <small><i class="hbTag ${x.tag.toLowerCase()}">${x.tag}</i>${x.id === here ? '<i class="hbHere">Start here</i>' : x.done ? '<i class="hbDone">Done ✓</i>' : ''}</small>
        <b>${x.title}</b><span>${x.body}</span>
        <em>${x.last != null ? `Last score ${x.last} · ` : ''}Start →</em></button>`).join('')}</div>
    <button class="hmMoreBtn" id="hcMore" aria-expanded="${moreOpen}">${moreOpen ? 'Fewer options ▴' : 'More options ▾'}</button>
    <div class="homeMore" id="hcMoreBox" ${moreOpen ? '' : 'hidden'}>
      <div class="hmRow"><h4>More drills</h4>
        <button class="hq" id="hcZu"><b>ZU-23-2 gun</b><small>Harder: a manual sight, so you set the lead yourself</small></button>
        <button class="hq" id="hcGun"><b>All gun drills</b><small>3D field firing · On Ground · Control Room · reload · UAV</small></button>
        <button class="hq" id="hcAcademy"><b>Radar lessons</b><small>${aca.size} of ${LESSONS.length} done · a coach explains every clue</small></button>
        <button class="hq" id="hcDrill"><b>Quick radar drill</b><small>Built around your weakest skill: ${weakName}</small></button>
      </div>
      <div class="hmRow"><h4>Real-world missions</h4>
        ${SCENARIOS.map((sc, i) => `<button class="hm" data-hm="${i}"><span class="hmIcon" aria-hidden="true">${WX_ICON[sc.cfg.weather ?? 'clear']}</span>
          <span><b>${sc.name}</b><small>${sc.agency} · ${sc.cfg.time === 'night' ? 'Night' : 'Day'} · ${WEATHER_LABEL[sc.cfg.weather ?? 'clear']}</small></span></button>`).join('')}
      </div>
      <div class="hmRow"><h4>For commanders and instructors</h4>
        <button class="hq" id="hcUnit"><b>Unit readiness</b><small>Who is ready for tonight · you: ${certified} of ${Object.keys(m).length} skills certified</small></button>
        <button class="hq" id="hcLectures"><b>Classroom library</b><small>Videos and notes by course</small></button>
      </div>
    </div>
  </div>`;
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
  render();
}
function render() {
  const el = $('#home'); if (!el) return;
  cancelAnimationFrame(raf);
  el.classList.toggle('menu', played);
  el.innerHTML = played ? menuHtml() : playHtml();
  if (!played) {
    $('#hcPlay').onclick = () => { played = true; render(); };
    $('#hcDemo').onclick = () => { closeHome(); hooks.showcase?.(); };
    fx(); ($('#hcPlay') as HTMLElement).focus({ preventScroll: true }); el.scrollTop = 0;
    return;
  }
  const go = (f: () => void) => () => { closeHome(); markTourSeen(); f(); };
  $('#hcBack').onclick = () => { played = false; render(); };
  $('#hcL70').onclick = go(() => hooks.openGun?.('field', { gun: 'l70', easy: true }));
  $('#hcZsu').onclick = go(() => hooks.openGun?.('field', { gun: 'zsu234', easy: true }));
  $('#hcPatrol').onclick = go(() => hooks.openGun?.('patrol'));
  $('#hcRadar').onclick = radarTraining;
  $('#hcMore').onclick = () => { moreOpen = !moreOpen; const box = $('#hcMoreBox') as HTMLElement; box.hidden = !moreOpen; const b = $('#hcMore') as HTMLElement; b.textContent = moreOpen ? 'Fewer options ▴' : 'More options ▾'; b.setAttribute('aria-expanded', String(moreOpen)); if (moreOpen) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
  $('#hcZu').onclick = go(() => hooks.openGun?.('field', { gun: 'zu23', easy: true }));
  $('#hcGun').onclick = go(() => hooks.openGun?.());
  $('#hcAcademy').onclick = () => { const done = new Set<number>(app.DB.academy?.done ?? []); const nx = LESSONS.find((l) => !done.has(l.n)) ?? LESSONS[0]; closeHome(); markTourSeen(); startLesson(nx.n); };
  $('#hcDrill').onclick = quickDrill;
  $$('[data-hm]').forEach((b: any) => (b.onclick = go(() => startScenario(SCENARIOS[+b.dataset.hm]))));
  $('#hcLectures').onclick = go(() => hooks.openLectures?.());
  $('#hcUnit').onclick = go(() => { app.renderUnit(); app.setPhase('learn'); ($('.learnTabs [data-t=unit]') as HTMLElement).click(); });
  fx(); ((document.querySelector('#home .hb.here') ?? $('#hcL70')) as HTMLElement).focus({ preventScroll: true }); el.scrollTop = 0;
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
    if (e.key === 'Escape' && played) { played = false; render(); }
  }, true);
  if (!skip) showHome();
}
export const homeOpen = () => open;
