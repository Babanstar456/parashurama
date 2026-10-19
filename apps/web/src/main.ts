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
/** `?fps`: frame-rate meter (current and lowest of the last 10 s) for checking performance on a unit laptop. */
function fpsMeter() {
  const el = document.createElement('div');
  el.id = 'fpsMeter';
  el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;padding:4px 8px;border-radius:3px;background:rgba(0,0,0,.75);color:#fff;font:12px/1.3 monospace;pointer-events:none';
  document.body.appendChild(el);
  let frames = 0, last = performance.now();
  const hist: number[] = [];
  const tick = (now: number) => {
    frames++;
    if (now - last >= 1000) {
      const fps = Math.round((frames * 1000) / (now - last));
      hist.push(fps); if (hist.length > 10) hist.shift();
      el.textContent = `${fps} fps · low ${Math.min(...hist)} (10 s)`;
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
  const [fg, ac, au, wi, ed, sc, v3, hm, shw, lt] = await Promise.all([import('./fieldguide'), import('./academy'), import('./audio'), import('./whatif'), import('./editor'), import('./scenarios'), import('./view3d'), import('./home'), import('./showcase'), import('./lite')]);
  fg.initFieldGuide(); ac.initAcademy(); au.initAudio(); lt.initLite(); wi.initWhatIf(); ed.initEditor({ online, user: session?.user ?? null, templates: session?.templates ?? null }); sc.initScenarios(); v3.init3D(); hm.initHome(); shw.initShowcase();
  boot();
  if (new URLSearchParams(location.search).has('fps')) fpsMeter();
  if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => undefined);
})();
