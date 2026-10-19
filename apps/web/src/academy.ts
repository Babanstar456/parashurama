import { brgOf, decisionClass, inReach, tti, visibleBlip, type DrillConfig, type Engine, type Spawn } from '@parashurama/engine';
import { app, hooks, on } from './app';
import { C, CONF, EFF, ORDER, TYPES, T } from './cfg';
import { $ } from './dom';
import { toggleGuide } from './fieldguide';

// ===================== the four guided lessons =====================
interface Lesson { n: number; title: string; goal: string; learn: string[]; cfg: DrillConfig; spawns: Spawn[]; speed: number; coach: 'full' | 'fade'; maxSec: number; }
const cfgOf = (n: number, o: Partial<DrillConfig>): DrillConfig => ({ seed: 9100 + n, drill: 0, time: 'day', terrain: 'rural', fault: 'none', faultSector: 0, pattern: 'mixed', difficulty: 2, focus: { sector: null, loiter: false, decoy: false }, ...o });
export const LESSONS: Lesson[] = [
  { n: 1, title: 'Friend or bird?', goal: 'Read every clue, and learn when not to fire.', coach: 'full', speed: 0.6, maxSec: 120,
    learn: ['What each clue row means', 'The friendly check decides friend or foe', 'Holding fire is also a decision'],
    cfg: cfgOf(1, {}), spawns: [{ type: 'bird', t: 0, brg: 60, dist: 1900 }, { type: 'friendly', t: 10, brg: 215 }] },
  { n: 2, title: 'Radio-controlled drones', goal: 'Spot the radio link and jam it.', coach: 'full', speed: 0.7, maxSec: 150,
    learn: ['2.4 GHz control link = recon drone', '5.8 GHz video link = FPV attack drone', 'Wait until the jammer can reach it'],
    cfg: cfgOf(2, {}), spawns: [{ type: 'recon', t: 0, brg: 120, dist: 2300 }, { type: 'fpv', t: 18, brg: 300, dist: 2900 }] },
  { n: 3, title: 'No radio link', goal: 'No radio means jamming fails, so spoof instead.', coach: 'full', speed: 0.8, maxSec: 150,
    learn: ['No emission + fast + high + wing = loitering munition', 'Several small echoes together = swarm', 'One GNSS spoof also hits nearby swarm drones'],
    cfg: cfgOf(3, { terrain: 'urban', pattern: 'swarm' }),
    spawns: [{ type: 'bird', t: 0, brg: 330, dist: 1700 }, { type: 'loiter', t: 2, brg: 40, dist: 2900 },
      ...[0, 0.35, 0.7, 1.05].map((d, i) => ({ type: 'swarm', t: 22 + d, brg: 220 + (i % 2 ? 2 : -2), dist: 2700 }))] },
  { n: 4, title: 'Night raid, RF detector down', goal: 'Put it all together with less help and one sensor missing.', coach: 'fade', speed: 1, maxSec: 150,
    learn: ['Decide without the radio clue: use speed, height, behaviour, camera', 'Most urgent contact first', 'Hints only when you ask (N) or stall'],
    cfg: cfgOf(4, { time: 'night', terrain: 'urban', fault: 'rf' }),
    spawns: [{ type: 'bird', t: 0, brg: 100, dist: 1800 }, { type: 'friendly', t: 2, brg: 250 }, { type: 'fpv', t: 5, brg: 20, dist: 2900 },
      { type: 'loiter', t: 16, brg: 160, dist: 2900 }, { type: 'recon', t: 26, brg: 290, dist: 2300 }] },
];
const decided = (c: any) => (TYPES[c.type].hostile ? c.state !== 'live' : c.engs.length > 0 || c.state !== 'live');
const allDecided = (L: Engine) => L.next >= L.spawns.length && L.contacts.every(decided);

export function startLesson(n: number, fromTour = false) {
  const l = LESSONS[n - 1];
  Object.assign(coach, { lesson: l, paused: new Set(), teach: null, hintFor: null, idleSince: new Map(), html: '' });
  app.startDrill(fromTour, { mode: 'academy', lesson: n, cfg: l.cfg, spawns: l.spawns, speed: l.speed, doneFn: allDecided, maxSec: l.maxSec });
}

// ===================== academy card on the brief =====================
function renderCard() {
  let card = $('#academyCard');
  if (!card) { card = document.createElement('div'); card.id = 'academyCard'; card.className = 'card academy'; $('.briefSide').prepend(card); }
  const done = new Set<number>(app.DB.academy.done);
  const next = LESSONS.find((l) => !done.has(l.n));
  card.classList.toggle('complete', !next);
  card.innerHTML = `<div class="cardHead"><h3>${next ? 'Academy' : 'Academy complete ✓'}</h3><span>${done.size} of ${LESSONS.length} guided lessons done</span></div>
   ${next ? '<p class="acadIntro">New here? Start with these. A coach explains every clue and every decision, about 10 minutes in total.</p>' : ''}
   <ol class="lessonList">${LESSONS.map((l) => `<li class="${done.has(l.n) ? 'done' : l === next ? 'next' : ''}"><b>${l.n}</b><div><strong>${l.title}</strong><span>${l.goal}</span></div>
     <button class="lessonBtn" data-lesson="${l.n}">${done.has(l.n) ? 'Replay' : l === next ? 'Start' : 'Open'}</button></li>`).join('')}</ol>
   <div class="acadFoot"><button class="linkBtn" id="openGuide">Open the field guide <kbd>F</kbd></button></div>`;
  card.querySelectorAll('.lessonBtn').forEach((b: any) => (b.onclick = () => startLesson(+b.dataset.lesson)));
  $('#openGuide').onclick = () => toggleGuide(true);
  $('#beginBtn').firstChild.textContent = next ? 'Begin scored drill ' : 'Begin drill ';
}

// ===================== the coach =====================
const coach: any = { lesson: null as Lesson | null, paused: new Set<string>(), teach: null as null | { cid: number; kind: string }, hintFor: null as null | number, idleSince: new Map<string, number>(), html: '', target: '', blip: null as null | number, frame: 0 };
const art = (w: string) => (/^(FPV|[AEIOU])/i.test(w) ? 'an' : 'a');
const kmOf = (c: any) => (Math.hypot(c.x, c.y) / 1000).toFixed(1);
const brg3 = (c: any) => String(Math.round(brgOf(c.x, c.y))).padStart(3, '0');
const isTracked = (c: any) => c.trackTick != null || app.live.did[c.id]?.track;
const idOf = (c: any) => c.idCls || app.live.did[c.id]?.id?.cls || null;
const needsAction = (c: any) => c.state === 'live' && (!idOf(c) || (c.effectAt == null && (!c.engs.length || (!c.engs[c.engs.length - 1].effective && c.engs[c.engs.length - 1].eff !== 'hold'))));

function explain(k: string, c: any, ok: boolean): string {
  const t = TYPES[c.type], kmh = Math.round(c.v * 3.6), alt = Math.round(c.alt);
  if (k === 'Radar') {
    const sp = kmh < 50 ? 'slow: birds and hovering drones are slow' : kmh < 100 ? 'medium speed: swarm drones and friendly UAVs' : 'fast: FPV attack drones and loitering munitions are fast';
    const h = alt < 70 ? 'very low: FPVs fly low to hide' : alt < 220 ? 'low to medium height' : 'high: loitering munitions cruise high';
    const e: Record<string, string> = { 'Very small': 'Tiny echo: a bird, FPV or swarm drone.', Small: 'Small echo: a quadcopter.', Medium: 'Medium echo: a bigger airframe, like a loitering munition or friendly UAV.', Large: 'Large echo: a big military UAV.' };
    return `<b>Radar.</b> ${kmh} km/h is ${sp}. ${alt} m is ${h}. ${e[t.echo] ?? ''}`;
  }
  if (!ok) return `<b>${k}.</b> <span class="wait">arriving…</span>`;
  if (k === 'Friendly check') return t.friendly ? '<b>Friendly check.</b> It matches our flight plan: <b>it is ours, never fire.</b>' : '<b>Friendly check.</b> No match, so it is not ours. It could still be a harmless bird.';
  if (k === 'RF signal') {
    if (app.live.cfg.fault === 'rf') return '<b>RF signal.</b> The detector is offline. Decide from the other clues.';
    if (t.friendly) return '<b>RF signal.</b> Our own data link.';
    if (t.civil) return `<b>RF signal.</b> ${t.rf}: a civil drone. <b>Report it and keep watching; never engage.</b>`;
    if (t.rfOn && !/2\.4|5\.8/.test(t.rf)) return `<b>RF signal.</b> ${t.rf}: someone is controlling it by radio. <b>A jammer can cut this link.</b>`;
    if (t.rfOn && t.gnss) return '<b>RF signal.</b> A 2.4 GHz control link: someone is flying it by remote control. <b>A jammer can cut this link.</b>';
    if (t.rfOn) return '<b>RF signal.</b> A 5.8 GHz video link: a pilot is watching live video. That is an FPV attack drone. <b>Jam it.</b>';
    return '<b>RF signal.</b> No emission: nobody is flying it by radio. It flies itself, or it is a bird. <b>Jamming will not work.</b>';
  }
  if (k === 'Behaviour') {
    const m: Record<string, string> = { approachHover: c.hover ? 'it stopped to watch you: a spy (recon) drone' : 'creeping closer slowly: typical of a recon drone', weave: 'fast and weaving low: an FPV attack run', straight: 'diving straight at you: a loitering munition', swarm: 'moving as part of a group: a swarm', orbit: 'circling a planned route: our own patrol', wander: 'wandering at random: a bird', surveil: c.hover ? 'circling at a distance to watch you: a military surveillance drone' : 'flying in on a steady course: it may stop to circle and watch' };
    return `<b>Behaviour.</b> ${m[t.motion]}.`;
  }
  if (k === 'Camera') {
    if (!ok) return '<b>Camera.</b> Too far for the camera yet; it sharpens as the contact closes.';
    const s: Record<string, string> = { quad: 'four rotors: a quadcopter (recon, FPV or swarm)', wing: 'fixed wings: a loitering munition, a military UAV or a friendly UAV', bird: 'flapping wings: a bird' };
    return `<b>Camera.</b> ${s[t.shape]}.`;
  }
  return '';
}
function weaponWhy(type: string): string {
  const t = TYPES[type];
  if (t.friendly) return 'It is ours. Holding fire is the right decision.';
  if (!t.hostile) return 'It is a bird. Holding fire saves your weapons.';
  const cls = decisionClass(t);
  return cls === 'rfLinked' ? 'It depends on a radio link, so the jammer cuts it.' : cls === 'gnssOnly' ? 'There is no radio link to jam, but it navigates by satellite, so spoofing sends it off course.' : 'No radio and no satellite navigation: only a physical interceptor works.';
}
function idle(key: string, tick: number, sec: number): boolean {
  if (!coach.idleSince.has(key)) coach.idleSince.set(key, tick);
  return tick - coach.idleSince.get(key) >= T(sec);
}
function adviseContact(c: any) {
  const L = app.L, l: Lesson = coach.lesson, t = TYPES[c.type], lab = app.live.labels[c.id] || '—';
  const rows = app.clueList(c);
  const key = rows.filter((r: any) => r.k !== 'Camera');
  const allIn = key.every((r: any) => r.ok);
  const lines = rows.map((r: any) => `<li class="${r.ok ? '' : 'pending'}">${explain(r.k, c, r.ok)}</li>`).join('');
  const fade = l.coach === 'fade';
  const cls = idOf(c);
  if (!cls) {
    if (!allIn) return { title: `Reading ${lab}`, html: `<ul class="cl">${lines}</ul><p class="nextHint">More clues are arriving. Read each one as it lands.</p>`, target: '#clues' };
    const showAnswer = !fade || coach.hintFor === c.id || idle(`id${c.id}`, L.tick, 8);
    if (!fade && !coach.paused.has(`id${c.id}`)) { coach.paused.add(`id${c.id}`); coach.teach = { cid: c.id, kind: 'id' }; }
    if (!showAnswer) return { title: `Your call on ${lab}`, html: `<ul class="cl">${lines}</ul><p class="nextHint">You have the clues. Decide what it is and how sure you are. Stuck? Press <kbd>N</kbd> for a hint.</p>`, target: '#idStep' };
    const sure = app.live.cfg.fault !== 'rf' || t.friendly;
    const conf = CONF[sure ? CONF.length - 1 : CONF.length - 2];
    const idx = ORDER.indexOf(c.type) + 1;
    const pick = app.live.pick;
    const target = pick.cls !== c.type ? `#idBody button[data-cls="${c.type}"]` : Math.abs((pick.conf ?? 0) - conf.p) > 0.01 ? `#idBody button[data-conf="${conf.p}"]` : '#commitBtn';
    return { title: `${lab} is ${art(t.label)} ${t.label}`, html: `<ul class="cl">${lines}</ul><div class="concl">Put together: ${t.deciding}. <b>This is ${art(t.label)} ${t.label.toLowerCase()}.</b></div>
      <p class="doThis">Press <kbd>${idx}</kbd> ${t.short}, then <kbd>${conf.key}</kbd> ${conf.label}, then <kbd>Enter</kbd>.</p>
      <p class="why">${sure ? 'All the clues agree, so you can say Certain.' : 'One sensor is down, so say Confident rather than Certain.'}${coach.teach ? ' The drill is paused for you; take your time.' : ''}</p>`, target };
  }
  let pre = '';
  if (cls !== c.type) pre = `<div class="oops">You said ${TYPES[cls].label.toLowerCase()}, but it is ${art(t.label)} <b>${t.label.toLowerCase()}</b>: ${t.deciding}. The label is locked; your weapon choice still counts, so choose for what it really is.</div>`;
  const last = c.engs[c.engs.length - 1];
  if (c.effectAt != null) return { title: `${lab}: weapon sent`, html: `${pre}<p>${EFF[c.effectBy].label} is on its way. It takes effect in ${Math.max(0, (c.effectAt - L.tick) * 0.1).toFixed(1)} s.</p><p class="nextHint">Look for the next yellow dot.</p>`, target: '' };
  if (!t.hostile || t.friendly) {
    if (c.engs.length) return { title: `${lab}: holding`, html: `${pre}<p>Correct: ${weaponWhy(c.type)}</p>`, target: '' };
    if (!fade && !coach.paused.has(`eng${c.id}`)) { coach.paused.add(`eng${c.id}`); coach.teach = { cid: c.id, kind: 'eng' }; }
    return { title: `${lab}: hold fire`, html: `${pre}<p class="doThis">Press <kbd>H</kbd> Hold.</p><p class="why">${weaponWhy(c.type)}</p>`, target: '#defBody button[data-eff="hold"]' };
  }
  const pref = C.doctrine.defeat.preferred[decisionClass(t)];
  if (last && !last.effective && last.eff !== 'hold') pre += `<div class="oops">${EFF[last.eff].label} had no effect on ${art(t.label)} ${t.label.toLowerCase()}. ${weaponWhy(c.type)}</div>`;
  const showAnswer = !fade || coach.hintFor === c.id || idle(`eng${c.id}`, L.tick, 8);
  if (inReach(c, pref)) {
    if (!showAnswer) return { title: `${lab}: your call`, html: `${pre}<p class="nextHint">A weapon can reach it now. Choose. Stuck? Press <kbd>N</kbd>.</p>`, target: '#defStep' };
    if (!fade && !coach.paused.has(`eng${c.id}`)) { coach.paused.add(`eng${c.id}`); coach.teach = { cid: c.id, kind: 'eng' }; }
    return { title: `${lab}: ${EFF[pref].label} now`, html: `${pre}<p class="doThis">Press <kbd>${EFF[pref].key}</kbd> ${EFF[pref].label}.</p><p class="why">${weaponWhy(c.type)}</p>`, target: `#defBody button[data-eff="${pref}"]` };
  }
  const w = app.windows(c)[pref];
  const wait = w ? Math.max(1, Math.ceil(w[0])) : null;
  const blips = L.contacts.filter((o: any) => visibleBlip(L, o) && !isTracked(o));
  const meanwhile = blips.length ? `<p class="nextHint">Meanwhile, a new dot is on the radar at ${brg3(blips[0])}°. Track it while you wait.</p>` : '';
  if (blips.length) coach.blip = blips[0].id;
  return { title: `${lab}: wait for reach`, html: `${pre}<p>The right weapon is <b>${EFF[pref].label}</b> (${weaponWhy(c.type).toLowerCase()}) It reaches ${(EFF[pref].range / 1000).toFixed(1)} km; ${lab} is at ${kmOf(c)} km.${wait ? ` Ready in about <b>${wait} s</b>: watch the coloured bar on its card.` : ''}</p>${meanwhile}`, target: `.ccard[data-id="${c.id}"]` };
}
function advise() {
  const L = app.L; coach.blip = null;
  const sel = app.selC();
  if (sel && isTracked(sel) && sel.state === 'live' && needsAction(sel)) return adviseContact(sel);
  const tracked = L.contacts.filter((c: any) => isTracked(c) && needsAction(c)).sort((a: any, b: any) => tti(a) - tti(b));
  if (tracked.length) { const c = tracked[0]; return { title: `${app.live.labels[c.id]} needs a decision`, html: `<p>Click its card on the right (or press <kbd>Tab</kbd>) to see its clues.</p>`, target: `.ccard[data-id="${c.id}"]` }; }
  const blips = L.contacts.filter((c: any) => visibleBlip(L, c) && !isTracked(c)).sort((a: any, b: any) => (tti(a) - tti(b)) || ((a.firstPaint ?? 0) - (b.firstPaint ?? 0)));
  if (blips.length) { const b = blips[0]; coach.blip = b.id; return { title: 'New contact', html: `<p>A yellow dot is on the radar at bearing <b>${brg3(b)}°</b>, <b>${kmOf(b)} km</b> out. <b>Click it</b> to start tracking.</p><p class="why">Yellow means unknown. The faster you click, the more Detect points you earn.</p>`, target: '' }; }
  if (L.next < L.spawns.length || L.contacts.some((c: any) => c.state === 'live' && !isTracked(c))) return { title: 'Watching the sky', html: '<p>No dot to act on yet. New dots appear as the radar beam sweeps over them.</p>', target: '' };
  return { title: 'All contacts handled', html: '<p>Nice work. The lesson ends in a moment and the debrief shows how you did.</p>', target: '' };
}
function render() {
  const l: Lesson = coach.lesson; if (!l || app.live.mode !== 'academy') return;
  const a = advise(); coach.target = a.target;
  const handled = app.L.contacts.filter(decided).length, total = l.spawns.length;
  const html = `<div class="coachLesson"><span>Lesson ${l.n} of ${LESSONS.length}</span><h3>${l.title}</h3><ul>${l.learn.map((x) => `<li>${x}</li>`).join('')}</ul></div>
    <div class="coachCard"><div class="coachKick">Coach</div><h4>${a.title}</h4>${a.html}</div>
    <div class="coachFoot"><span>Handled ${handled} of ${total}</span>${l.coach === 'fade' ? '<button class="linkBtn" id="hintBtn">Hint <kbd>N</kbd></button>' : ''}<button class="linkBtn" id="coachGuide">Field guide <kbd>F</kbd></button></div>`;
  if (html !== coach.html) {
    coach.html = html; $('#coachCol').innerHTML = html;
    const hb = $('#hintBtn'); if (hb) hb.onclick = hint;
    $('#coachGuide').onclick = () => toggleGuide(true);
  }
}
function hint() { const c = app.selC(); if (c) { coach.hintFor = c.id; coach.html = ''; render(); } }
function glow() {
  document.querySelectorAll('.coachGlow').forEach((e) => e.classList.remove('coachGlow'));
  if (app.live.mode !== 'academy' || !coach.target) return;
  const el = document.querySelector(coach.target); if (el) el.classList.add('coachGlow');
}

export function initAcademy() {
  (window as any).__coach = coach;
  if (!$('#coachCol')) { const d = document.createElement('aside'); d.id = 'coachCol'; d.className = 'coachCol'; $('.fightGrid').prepend(d); }
  const t0 = app.TOUR[0]; t0.x = 'A counter-drone decision trainer. Every drill runs in three steps: <b>Brief</b>, <b>Fight</b>, <b>Learn</b>. New here? The <b>Academy</b> teaches you with a coach. This tour takes about a minute.';
  app.TOUR.splice(1, 0, { p: 'brief', sel: '#academyCard', t: 'Start with the Academy', x: 'Four short guided lessons. A coach explains every clue in plain words, tells you what the contact is and why, and points at the right button. After lesson 4 you are ready for scored drills.' });
  const begin = app.TOUR.find((s: any) => s.p === 'brief' && s.sel === '#beginBtn');
  if (begin) begin.x = 'Press this to begin. If you have not finished the Academy, the tour starts lesson 1 for you, and keeps explaining inside the drill.';
  hooks.tourBegin = () => { const done = new Set(app.DB.academy.done); const nx = LESSONS.find((l) => !done.has(l.n)); if (nx) startLesson(nx.n, true); else app.startDrill(true); };
  hooks.blockers.push(() => app.live.mode === 'academy' && coach.teach != null);
  hooks.next = () => {
    const R = app.R; if (!R || R.mode !== 'academy') return false;
    if (R.lesson < LESSONS.length) startLesson(R.lesson + 1); else { app.renderBrief(); app.setPhase('brief'); }
    return true;
  };
  on('brief', renderCard);
  on('start', () => { coach.html = ''; $('#coachCol').innerHTML = ''; if (app.live.mode !== 'academy') coach.lesson = null; });
  on('act', (e: any) => {
    if (coach.teach && e.c.id === coach.teach.cid && ((coach.teach.kind === 'id' && e.k === 'id') || (coach.teach.kind === 'eng' && e.k === 'eng'))) coach.teach = null;
    coach.html = '';
  });
  on('frame', () => { if (app.live.mode !== 'academy') return; if (++coach.frame % 8 === 0) render(); glow(); });
  on('radar', ({ ctx, w2c }: any) => {
    if (app.live.mode !== 'academy' || coach.blip == null) return;
    const c = app.L.contacts.find((x: any) => x.id === coach.blip); if (!c) return;
    const [px, py] = w2c(c.x, c.y); const r = 20 + ((performance.now() / 40) % 18);
    ctx.save(); ctx.strokeStyle = '#F2C94C'; ctx.lineWidth = 2.5; ctx.globalAlpha = 1 - (r - 20) / 22;
    ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = '#F2C94C'; ctx.font = '600 20px "Barlow Condensed", sans-serif'; ctx.fillText('CLICK', px + 26, py + 6); ctx.restore();
  });
  on('finish', (R: any) => {
    if (R.mode !== 'academy') return;
    coach.teach = null;
    const d = new Set<number>(app.DB.academy.done); d.add(R.lesson); app.DB.academy.done = [...d].sort(); app.saveDB();
  });
  on('learn', (R: any) => {
    const nc = $('#nextCard');
    if (R.mode !== 'academy') { nc.querySelector('h3').textContent = 'The enemy has adapted'; return; }
    const l = LESSONS[R.lesson - 1], nx = LESSONS[R.lesson];
    $('#scoreCard .kicker').textContent = `Academy · Lesson ${l.n} of ${LESSONS.length} · ${l.title}`;
    $('#scoreCard .verdict').outerHTML = '<div class="verdict yes">Lesson complete ✓ · practice only, not counted in your record</div>';
    nc.querySelector('h3').textContent = nx ? `Next: lesson ${nx.n} · ${nx.title}` : 'Academy complete';
    $('#nextText').innerHTML = nx ? `You will learn: ${nx.learn.join('; ')}.` : 'You can read every clue and pick the right response. Scored drills now count toward your skill record and certification, and the enemy starts studying your habits.';
    $('#nextBtn').firstChild.textContent = nx ? `Start lesson ${nx.n} ` : 'Go to scored drills ';
  });
  addEventListener('keydown', (e) => {
    if (app.phase !== 'fight' || app.live.mode !== 'academy') return;
    if (e.key === ' ' && coach.teach) { e.preventDefault(); e.stopImmediatePropagation(); coach.teach = null; }
    if (e.key.toLowerCase() === 'n') hint();
  }, { capture: true });
}
