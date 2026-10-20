// Boot order matters: pick online/offline mode and apply the unit's config BEFORE the app modules read it.
import '@fontsource/saira-stencil-one/latin-400.css';
import '@fontsource/barlow-condensed/latin-500.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import './styles.css';
import { detectServer, startSession, initOnline, type Session } from './online';
import { toast } from './toast';

async function applyConfig(c: unknown, source: string) {
  try { const { useConfig } = await import('./validator'); useConfig(c as any); }
  catch (e) { console.warn(e); toast(`${source} settings were invalid, so the defaults are used.`); }
}
/** `?fps`: frame-rate meter (current and lowest of the last 10 s) for checking performance on a unit laptop.
 *  It also keeps a per-view record (menus, drill, drill with the 3D view expanded); click the meter to copy the report. */
function fpsMeter() {
  const el = document.createElement('div');
  el.id = 'fpsMeter';
  el.title = 'Click to copy the frame-rate report';
  el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;padding:4px 8px;border-radius:3px;background:rgba(0,0,0,.75);color:#fff;font:12px/1.3 monospace;cursor:pointer';
  document.body.appendChild(el);
  let frames = 0, last = performance.now();
  const hist: number[] = [], byView: Record<string, number[]> = {};
  const view = () => {
    if (!document.querySelector('#fight.on')) return 'menus';
    const v3 = document.querySelector('#view3d');
    return v3?.classList.contains('big') ? 'drill, 3D expanded' : v3?.querySelector('canvas') && !v3.classList.contains('min') ? 'drill, radar + small 3D' : 'drill, radar only';
  };
  const report = () => [`PARASHURAMA ?fps report · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${navigator.userAgent}`,
    ...Object.entries(byView).map(([v, a]) => `${v}: average ${Math.round(a.reduce((x, y) => x + y, 0) / a.length)} fps, lowest ${Math.min(...a)} fps (${a.length} s)`)].join('\n');
  (window as any).fpsReport = report;
  el.addEventListener('click', () => { const r = report(); console.log(r); navigator.clipboard?.writeText(r).then(() => toast('Frame-rate report copied'), () => toast('Report printed to the browser console')); });
  const tick = (now: number) => {
    frames++;
    if (now - last >= 1000) {
      const fps = Math.round((frames * 1000) / (now - last));
      hist.push(fps); if (hist.length > 10) hist.shift();
      if (!document.hidden) (byView[view()] ??= []).push(fps);
      el.textContent = `${fps} fps · low ${Math.min(...hist)} (10 s) · ${view()}`;
      frames = 0; last = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
(async () => {
  const online = await detectServer();
  let session: Session | null = null;
  if (online) { session = await startSession(); if (session.config) await applyConfig(session.config, 'Unit'); }
  else { try { const raw = localStorage.getItem('parashurama.config'); if (raw) await applyConfig(JSON.parse(raw), 'Saved'); } catch { /* ignore */ } }
  const { app, hooks, on, boot } = await import('./app');
  const { planNext } = await import('@parashurama/engine');
  if (session) { app.DB.H = session.history; hooks.planOpts = { adaptive: session.user.cohort !== 'control' }; app.plan = planNext(app.DB.H, undefined, hooks.planOpts); initOnline(app, hooks, on, session); }
  const [fg, ac, au, wi, ed, sc, v3, hm, shw, lt, lec, gn] = await Promise.all([import('./fieldguide'), import('./academy'), import('./audio'), import('./whatif'), import('./editor'), import('./scenarios'), import('./view3d'), import('./home'), import('./showcase'), import('./lite'), import('./lectures'), import('./gun')]);
  fg.initFieldGuide(); ac.initAcademy(); au.initAudio(); lt.initLite(); lec.initLectures({ online, user: session?.user ?? null }); wi.initWhatIf(); ed.initEditor({ online, user: session?.user ?? null, templates: session?.templates ?? null }); sc.initScenarios(); v3.init3D(); hm.initHome(); shw.initShowcase(); gn.initGun();
  boot();
  if (new URLSearchParams(location.search).has('fps')) fpsMeter();
  if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => undefined);
})();
