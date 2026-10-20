// Mission Hub: the front door. Explains the product in one screen and gives one-click paths for
// beginners (Academy), trainees (adaptive drill), field units (real-world missions) and commanders (readiness).
import { SCENARIOS, WEATHER_LABEL, mulberry, mastery } from '@parashurama/engine';
import { app, hooks } from './app';
import { $, $$ } from './dom';
import { LESSONS, startLesson } from './academy';
import { startScenario } from './scenarios';
import { CERT } from './cfg';

let open = false, raf = 0;
const WX_ICON: Record<string, string> = { clear: '☀', rain: '☔', fog: '🌫', dust: '🌪' };

function html(): string {
  const done = new Set<number>(app.DB.academy?.done ?? []);
  const next = LESSONS.find((l) => !done.has(l.n));
  const m = mastery(app.DB.H);
  const weakest = (['night', 'swarm', 'degraded', 'weather'] as const).reduce((a, b) => (m[a] <= m[b] ? a : b));
  const weakName = { night: 'night drills', swarm: 'swarm attacks', degraded: 'faulty sensors', weather: 'bad weather' }[weakest];
  const certified = Object.values(m).filter((v) => v >= CERT.certifiedMastery).length;
  return `
  <canvas id="homeFx" aria-hidden="true"></canvas>
  <div class="homeIn">
    <div class="homeHero">
      <div class="homeKicker">Smart India Hackathon 2026 · SIH26247 · Ministry of Defence</div>
      <h1 class="homeTitle">PARASHURAMA</h1>
      <p class="homeTag">Train every soldier to stop hostile drones.<br><span>On any laptop. Even offline.</span></p>
      <button class="homeDemo" id="hcDemo"><i aria-hidden="true">▶</i><span><b>Watch the 90-second demo</b><small>The whole product, narrated. No clicks needed.</small></span></button>
      <ol class="homeSteps">
        <li><i>1</i><b>Learn</b><span>Short lessons with a coach who explains every clue.</span></li>
        <li><i>2</i><b>Fight</b><span>Live drills on radar and in 3D. The enemy AI attacks your weak spots.</span></li>
        <li><i>3</i><b>Improve</b><span>Every decision scored and explained, replayed against an expert.</span></li>
      </ol>
      <p class="homeMobile">📱 Watch the demo or try a mission here. Full drills work best on a laptop or a tablet in landscape.</p>
      <div class="homeChips"><span>Works offline</span><span>Every score explained</span><span>Night · rain · fog · dust</span><span>3D view · VR-ready</span><span>Results can't be faked</span></div>
    </div>
    <div class="homeCards">
      <button class="hc hcPrimary" id="hcAcademy">
        <small>${next ? `New here? Start here · lesson ${next.n} of ${LESSONS.length}` : 'Academy complete ✓'}</small>
        <b>${next ? 'Learn in 10 minutes' : 'Replay the Academy'}</b>
        <span>${next ? `A coach walks you through every clue and decision. No experience needed.` : 'All four lessons done. Replay any lesson from the brief.'}</span>
        <div class="hcProg">${LESSONS.map((l) => `<i class="${done.has(l.n) ? 'on' : ''}"></i>`).join('')}</div>
        <em>${next ? `Start: ${next.title}` : 'Open lesson 1'} →</em>
      </button>
      <button class="hc" id="hcDrill">
        <small>Adaptive drill</small><b>Quick drill</b>
        <span>A 2-minute drill the enemy AI builds around your weakest skill: <strong>${weakName}</strong>.</span>
        <em>Begin →</em>
      </button>
      <div class="hc hcMissions">
        <small>Real-world missions</small><b>Defend a real kind of site</b>
        <div class="hmList">${SCENARIOS.map((s, i) => `<button class="hm" data-hm="${i}"><span class="hmIcon" aria-hidden="true">${WX_ICON[s.cfg.weather ?? 'clear']}</span>
          <span><b>${s.name}</b><small>${s.agency} · ${s.cfg.time === 'night' ? 'Night' : 'Day'} · ${WEATHER_LABEL[s.cfg.weather ?? 'clear']}</small></span><em>→</em></button>`).join('')}</div>
      </div>
      <button class="hc" id="hcUnit">
        <small>For commanders</small><b>Unit readiness</b>
        <span>Who in the troop is ready for tonight: night, swarm, faulty sensors or bad weather. You: ${certified} of ${Object.keys(m).length} skills certified.</span>
        <em>Open the board →</em>
      </button>
      <button class="hc hcGun" id="hcGun">
        <small>Air defence guns · ZU-23-2 / ZSU-23-4</small><b>Control Room · On Ground</b>
        <span>Give the fire orders, or crew the gun: load, lay, set the lead and fire only on the order. Real ballistics.</span>
        <em>Open the gun drills →</em>
      </button>
      <button class="hc" id="hcLectures">
        <small>Self-study · by course</small><b>Classroom library</b>
        <span>Videos and notes from your instructors: Control Room, On Ground, UAV GCS, live-fire safety and more.</span>
        <em>Open the library →</em>
      </button>
    </div>
  </div>
  <div class="homeFoot"><span>Team Dhwanik_TH06</span><span>Vendor-neutral · indigenous · runs on hardware every unit already has</span><span>Training values only, not equipment specifications</span></div>`;
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
  $('#hcAcademy').onclick = () => { const done = new Set<number>(app.DB.academy?.done ?? []); const nx = LESSONS.find((l) => !done.has(l.n)) ?? LESSONS[0]; closeHome(); markTourSeen(); startLesson(nx.n); };
  $('#hcDrill').onclick = () => { closeHome(); app.renderBrief(); app.setPhase('brief'); if (!app.DB.tourDone) app.startTour(0); };
  $$('[data-hm]').forEach((b: any) => (b.onclick = () => { closeHome(); markTourSeen(); startScenario(SCENARIOS[+b.dataset.hm]); }));
  $('#hcDemo').onclick = () => { closeHome(); hooks.showcase?.(); };
  $('#hcLectures').onclick = () => { closeHome(); markTourSeen(); hooks.openLectures?.(); };
  $('#hcGun').onclick = () => { closeHome(); markTourSeen(); hooks.openGun?.(); };
  $('#hcUnit').onclick = () => { closeHome(); markTourSeen(); app.renderUnit(); app.setPhase('learn'); ($('.learnTabs [data-t=unit]') as HTMLElement).click(); };
  fx();
  ($('#hcAcademy') as HTMLElement).focus({ preventScroll: true }); el.scrollTop = 0;
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
