import { decisionClass } from '@parashurama/engine';
import { C, TYPES, ORDER, EFF } from './cfg';
import { $ } from './dom';
import { app, on } from './app';

const CAMERA: Record<string, string> = { quad: '4 rotors', wing: 'Fixed wing', bird: 'Flapping wings' };
export function actionFor(type: string): string {
  const t = TYPES[type];
  if (t.civil) return 'Hold / report (H)';
  if (t.friendly || !t.hostile) return 'Hold (H)';
  const e = EFF[C.doctrine.defeat.preferred[decisionClass(t)]];
  return `${e.label} (${e.key})`;
}
function html(): string {
  const rows = ORDER.map((k) => {
    const t = TYPES[k];
    const col = t.friendly ? 'var(--blue)' : t.hostile ? 'var(--red)' : 'var(--green)';
    return `<tr><td><b style="color:${col}">${t.label}</b></td><td>~${Math.round(t.speed * 3.6)} km/h</td><td>${t.alt[0]}–${t.alt[1]} m</td><td>${t.echo}</td>
      <td>${t.rf}</td><td>${t.behaviour.replace('{n}', 'others')}</td><td>${CAMERA[t.shape]}</td><td><b>${actionFor(k)}</b></td></tr>`;
  }).join('');
  return `<div class="fgHead"><h3>Field guide</h3><button class="fgClose" id="fgClose" aria-label="Close field guide">Close <kbd>F</kbd></button></div>
  <ol class="fgSteps">
    <li><b>Friendly check says “matches flight plan”?</b> It is ours. Identify Friendly UAV, then <b>Hold</b>. Never fire.</li>
    <li><b>RF signal shows a control or video link?</b> Someone is flying it by radio. <b>RF jam</b> cuts the link.</li>
    <li><b>No radio emission, slow and erratic?</b> A bird. <b>Hold</b>; don't waste a weapon.</li>
    <li><b>No radio emission, fast and straight in, or flying in a group?</b> It navigates by satellite. Jamming fails; <b>GNSS spoof</b> works (it also hits nearby swarm drones).</li>
    <li><b>Weapon greyed out?</b> It is not in reach yet. Watch the coloured bar on its card, and handle the most urgent contact first.</li>
    <li><b>How sure are you?</b> Say <b>Certain</b> only when friendly check, radio and behaviour all agree. If a sensor is down, say Confident.</li>
    <li><b>Rain, fog or dust?</b> Radar paints blips less often and the camera only works close in. Do not wait for the picture: decide from <b>RF signal and behaviour</b>, and say Confident rather than Certain.</li>
  </ol>
  <div class="wrapx"><table class="fgTable"><tr><th>Contact</th><th>Speed</th><th>Height</th><th>Echo</th><th>Radio</th><th>Behaviour</th><th>Camera</th><th>Do this</th></tr>${rows}</table></div>
  <p class="fgNote">Speeds vary by about ±12%. The guide is available on the brief, in the Academy and in the debrief, not during scored drills.</p>`;
}
export function guideAllowed(): boolean { return !(app.phase === 'fight' && app.live.mode !== 'academy'); }
export function toggleGuide(force?: boolean) {
  const el = $('#fieldGuide');
  const open = force ?? !el.classList.contains('on');
  if (open && !guideAllowed()) return;
  if (open) el.innerHTML = html();
  el.classList.toggle('on', open);
  if (open) $('#fgClose').onclick = () => toggleGuide(false);
}
export function initFieldGuide() {
  if (!$('#fieldGuide')) { const d = document.createElement('aside'); d.id = 'fieldGuide'; d.className = 'fieldGuide'; d.setAttribute('aria-label', 'Field guide'); document.body.appendChild(d); }
  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.closest?.('input,select,textarea')) return;
    if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey) toggleGuide();
    if (e.key === 'Escape') toggleGuide(false);
  });
  $('#guideBtn').onclick = () => toggleGuide();
  on('start', () => toggleGuide(false));
}
