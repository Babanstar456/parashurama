// Lite mode for low-spec laptops: no auto-opened 3D view, 1× 3D pixel ratio, no 3D weather particles.
// Turned on automatically when the first 5 s of a drill average under 25 fps, by ?lite, or by the drill's Lite button.
import { app, on } from './app';
import { $ } from './dom';
import { toast } from './toast';

const subs: ((on: boolean) => void)[] = [];
export const isLite = () => !!app.DB.settings?.lite || new URLSearchParams(location.search).has('lite');
export const onLite = (fn: (on: boolean) => void) => subs.push(fn);
export function setLite(v: boolean) {
  app.DB.settings.lite = v; app.saveDB(); label(); subs.forEach((f) => f(isLite()));
}
function label() { const b = $('#liteBtn'); if (b) b.firstChild!.textContent = isLite() ? 'Lite on ' : 'Lite off '; }

/** Average frame rate over the first 5 s of a drill (after 1 s of warm-up). */
function measure(done: (fps: number) => void) {
  let start = 0, frames = 0;
  const step = (t: number) => {
    if (app.phase !== 'fight') return;
    if (!start) start = t + 1000;
    if (t >= start) frames++;
    if (t - start >= 5000) return done((frames * 1000) / (t - start));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function initLite() {
  const ctl = $('#soundBtn');
  if (ctl) {
    const b = document.createElement('button'); b.className = 'ghostBtn'; b.id = 'liteBtn'; b.title = 'Lite mode for slower laptops';
    b.innerHTML = 'Lite off <kbd>L</kbd>'; b.onclick = () => setLite(!isLite()); ctl.after(b); label();
  }
  addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'l' && app.phase === 'fight' && !(e.target as HTMLElement)?.closest?.('input,select,textarea')) setLite(!isLite()); });
  let checked = false;
  on('start', () => {
    // Measure on the first real drill only: not in the Academy or the narrated demo (both keep their own layout).
    if (checked || isLite() || app.live.mode === 'academy' || app.live.mode === 'showcase') return;
    checked = true;
    measure((fps) => { if (fps < 25 && !isLite()) { setLite(true); toast(`This laptop ran at ${Math.round(fps)} fps, so Lite mode is on (3D view closed, fewer effects). Press L to change.`); } });
  });
}
