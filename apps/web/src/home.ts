// Mission Hub: the front door, built as a guided path. One recommended next step with a single Continue button,
// a four-step training path that ticks itself off (lessons → first radar drill → the gun in 3D → the urban patrol),
// and everything else one click away in a quiet "go straight to" row.
import { SCENARIOS, WEATHER_LABEL, mulberry, mastery } from '@parashurama/engine';
import { app, hooks } from './app';
import { $, $$ } from './dom';
import { LESSONS, startLesson } from './academy';
import { startScenario } from './scenarios';
import { CERT } from './cfg';

let open = false, raf = 0;
const WX_ICON: Record<string, string> = { clear: '☀', rain: '☔', fog: '🌫', dust: '🌪' };
const local = (k: string): any[] => { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

interface Step { key: string; title: string; why: string; status: string; done: boolean; cta: string; go: () => void; }
function path(): { steps: Step[]; next: Step | null; weakName: string } {
  const done = new Set<number>(app.DB.academy?.done ?? []);
  const lesson = LESSONS.find((l) => !done.has(l.n));
  const m = mastery(app.DB.H);
  const weakest = (['night', 'swarm', 'degraded', 'weather'] as const).reduce((a, b) => (m[a] <= m[b] ? a : b));
  const weakName = { night: 'night drills', swarm: 'swarm attacks', degraded: 'faulty sensors', weather: 'bad weather' }[weakest];
  const gunField = local('parashurama.gunH').filter((r) => r?.game === 'field'), patrols = local('parashurama.patrolH');
  const steps: Step[] = [
    { key: 'learn', title: 'Learn the basics', why: 'Four short lessons. A coach explains every clue and when not to fire. About 10 minutes.',
      status: `${done.size} of ${LESSONS.length} lessons`, done: !lesson, cta: lesson ? `Start lesson ${lesson.n}: ${lesson.title}` : 'Replay a lesson',
      go: () => { closeHome(); markTourSeen(); startLesson((lesson ?? LESSONS[0]).n); } },
    { key: 'radar', title: 'Your first radar drill', why: 'Spot, identify and defeat drones on the radar. Two minutes, every decision scored and explained.',
      status: app.DB.H.length ? `${app.DB.H.length} drill${app.DB.H.length === 1 ? '' : 's'} done` : 'Not tried yet', done: app.DB.H.length > 0, cta: 'Start a radar drill',
      go: () => quickDrill() },
    { key: 'gun', title: 'Fire the gun in 3D', why: 'Sit at a ZU-23-2 by day: search the sky, report and identify each drone, then fire only on clearance.',
      status: gunField.length ? `${gunField.length} field drill${gunField.length === 1 ? '' : 's'} done` : 'Not tried yet', done: gunField.length > 0, cta: 'Take the gun',
      go: () => { closeHome(); markTourSeen(); hooks.openGun?.('field'); } },
    { key: 'patrol', title: 'Urban patrol', why: 'Drive a ZSU-23-4 through an old town. Drones pop up over the rooftops: engage only hostiles and spare the buildings.',
      status: patrols.length ? `${patrols.length} patrol${patrols.length === 1 ? '' : 's'} · last ${patrols[patrols.length - 1].total}` : 'Not tried yet', done: patrols.length > 0, cta: 'Start the patrol',
      go: () => { closeHome(); markTourSeen(); hooks.openGun?.('patrol'); } },
  ];
  return { steps, next: steps.find((x) => !x.done) ?? null, weakName };
}
function quickDrill() { closeHome(); app.renderBrief(); app.setPhase('brief'); if (!app.DB.tourDone) app.startTour(0); }

function html(): string {
  const { steps, next, weakName } = path();
  const m = mastery(app.DB.H), certified = Object.values(m).filter((v) => v >= CERT.certifiedMastery).length;
  const n = next ? steps.indexOf(next) + 1 : 0, doneN = steps.filter((x) => x.done).length;
  return `
  <canvas id="homeFx" aria-hidden="true"></canvas>
  <div class="homeIn homeGuided">
    <div class="homeHero">
      <div class="homeKicker">Smart India Hackathon 2026 · SIH26247 · Ministry of Defence</div>
      <h1 class="homeTitle">PARASHURAMA</h1>
      <p class="homeTag">Train every soldier to stop hostile drones.<br><span>On any laptop. Even offline.</span></p>
      <button class="homeDemo" id="hcDemo"><i aria-hidden="true">▶</i><span><b>Watch the 90-second demo</b><small>See the whole product first. No clicks needed.</small></span></button>
      <ul class="homeHow"><li><b>Spot</b> the drone on radar, in 3D or by ear</li><li><b>Identify</b> it: hostile, friendly, civil or a bird</li><li><b>Decide</b> how to defeat it, and see why each choice scores what it does</li></ul>
    </div>
    <div class="homeGuide">
      <section class="hgNext" aria-labelledby="hgNextT">
        <small>${next ? `Your next step · ${n} of ${steps.length}` : 'Training path complete ✓'}</small>
        <b id="hgNextT">${next ? next.title : 'Keep sharp'}</b>
        <span>${next ? next.why : `A quick drill the enemy AI builds around your weakest skill: <strong>${weakName}</strong>.`}</span>
        <button class="hgGo" id="hcNext">${next ? next.cta : 'Start a quick drill'} <i aria-hidden="true">→</i></button>
      </section>
      <section class="hgPath" aria-label="Your training path">
        <h3>Your training path <small>${doneN} of ${steps.length} done</small></h3>
        <ol>${steps.map((x, i) => `<li><button class="hgStep ${x.done ? 'done' : ''} ${x === next ? 'now' : ''}" data-step="${x.key}">
          <i aria-hidden="true">${x.done ? '✓' : i + 1}</i><span><b>${x.title}</b><small>${x.status}</small></span>${x === next ? '<em>You are here</em>' : ''}</button></li>`).join('')}</ol>
      </section>
    </div>
  </div>
  <div class="homeMore">
    <div class="hmRow"><h4>Or go straight to</h4>
      <button class="hq" id="hcDrill"><b>Quick radar drill</b><small>Built around your weakest skill: ${weakName}</small></button>
      <button class="hq" id="hcGun"><b>Gun drills</b><small>3D field firing · Control Room · On Ground</small></button>
      <button class="hq" id="hcPatrol"><b>Urban patrol</b><small>Drive the ZSU-23-4 through town</small></button>
      <button class="hq" id="hcUnit"><b>Unit readiness</b><small>For commanders · you: ${certified} of ${Object.keys(m).length} skills certified</small></button>
      <button class="hq" id="hcLectures"><b>Classroom library</b><small>Videos and notes by course</small></button>
    </div>
    <div class="hmRow"><h4>Real-world missions</h4>
      ${SCENARIOS.map((sc, i) => `<button class="hm" data-hm="${i}"><span class="hmIcon" aria-hidden="true">${WX_ICON[sc.cfg.weather ?? 'clear']}</span>
        <span><b>${sc.name}</b><small>${sc.agency} · ${sc.cfg.time === 'night' ? 'Night' : 'Day'} · ${WEATHER_LABEL[sc.cfg.weather ?? 'clear']}</small></span></button>`).join('')}
    </div>
  </div>
  <div class="homeFoot"><span>Team Dhwanik_TH06</span><span>Works offline · every score explained</span><span>Training values only, not equipment specifications</span></div>`;
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
  el.innerHTML = html(); el.classList.add('on'); open = true; document.body.classList.add('homeOn');
  const { steps, next } = path();
  $('#hcNext').onclick = () => (next ? next.go() : quickDrill());
  $$('[data-step]').forEach((b: any) => (b.onclick = () => steps.find((x) => x.key === b.dataset.step)?.go()));
  $('#hcDrill').onclick = quickDrill;
  $$('[data-hm]').forEach((b: any) => (b.onclick = () => { closeHome(); markTourSeen(); startScenario(SCENARIOS[+b.dataset.hm]); }));
  $('#hcDemo').onclick = () => { closeHome(); hooks.showcase?.(); };
  $('#hcLectures').onclick = () => { closeHome(); markTourSeen(); hooks.openLectures?.(); };
  $('#hcGun').onclick = () => { closeHome(); markTourSeen(); hooks.openGun?.(); };
  $('#hcPatrol').onclick = () => { closeHome(); markTourSeen(); hooks.openGun?.('patrol'); };
  $('#hcUnit').onclick = () => { closeHome(); markTourSeen(); app.renderUnit(); app.setPhase('learn'); ($('.learnTabs [data-t=unit]') as HTMLElement).click(); };
  fx();
  ($('#hcNext') as HTMLElement).focus({ preventScroll: true }); el.scrollTop = 0;
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
    if (e.key === 'Escape') ($('#hcDrill') as HTMLElement).click();
  }, true);
  if (!skip) showHome();
}
export const homeOpen = () => open;
