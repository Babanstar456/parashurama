// Real-world scenario library: ready-made drills inspired by Indian incidents and user agencies
// (Army/IAF air defence, BSF, CISF). Data lives in config/scenarios.json, so instructors add scenarios without code.
import { SCENARIOS, scenarioCfg, WEATHER_LABEL, FAULT_LABEL, type Scenario } from '@parashurama/engine';
import { app, on } from './app';
import { TYPES } from './cfg';
import { $ } from './dom';
import { toast } from './toast';

let current: Scenario | null = null;
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

function chips(s: Scenario): string {
  const c = s.cfg, w = c.weather ?? 'clear';
  const hostiles = s.spawns.filter((x) => TYPES[x.type].hostile).length;
  const list = [c.time === 'night' ? 'Night' : 'Day', c.terrain === 'urban' ? 'Urban' : 'Rural', WEATHER_LABEL[w]];
  if (c.fault !== 'none') list.push(FAULT_LABEL[c.fault]);
  if (c.pattern === 'swarm') list.push('Swarm');
  if (c.roe && c.roe !== 'free') list.push(c.roe === 'peacetime' ? 'Peacetime ROE' : 'Tight ROE');
  list.push(`${hostiles} hostile${hostiles === 1 ? '' : 's'}`);
  return list.map((x) => `<span class="scChip">${x}</span>`).join('');
}

function render() {
  let card = $('#scnCard');
  if (!card) { card = document.createElement('div'); card.id = 'scnCard'; card.className = 'card'; $('#intentCard').before(card); }
  card.innerHTML = `<div class="cardHead"><h3>Real-world scenarios</h3><span>Fixed raids · scored</span></div>
  <div class="tplList">${SCENARIOS.map((s, i) => `<details class="scItem"><summary><b>${esc(s.name)}</b><small>${esc(s.agency)}</small></summary>
    <div class="scBody"><div class="scChips">${chips(s)}</div><p>${esc(s.context)}</p><p><b>Lesson:</b> ${esc(s.lesson)}</p>
    <button class="smallBtn" data-scn="${i}">Start scenario</button></div></details>`).join('')}</div>`;
  card.querySelectorAll('[data-scn]').forEach((b: any) => (b.onclick = () => startScenario(SCENARIOS[+b.dataset.scn])));
}

export function startScenario(s: Scenario) {
  current = s;
  app.startDrill(false, { mode: 'template', template: s.name, cfg: scenarioCfg(s, app.plan.cfg.drill), spawns: s.spawns });
  toast(`${s.name}: ${s.lesson}`, 9000);
}

/** In the debrief, remind the trainee what this scenario was meant to teach. */
function debriefNote() {
  $('#scnNote')?.remove();
  document.getElementById('toast')?.classList.remove('on');
  if (!current || app.live.template !== current.name) { current = null; return; }
  const n = document.createElement('div');
  n.id = 'scnNote'; n.className = 'card scnNote';
  n.innerHTML = `<div class="cardHead"><h3>Scenario: ${esc(current.name)}</h3><span>${esc(current.agency)}</span></div><p><b>What this scenario teaches:</b> ${esc(current.lesson)}</p>`;
  $('#tabDrill').prepend(n);
  current = null;
}

export function initScenarios() {
  render();
  on('brief', render);
  on('finish', debriefNote);
  on('brief', () => $('#scnNote')?.remove());
}
