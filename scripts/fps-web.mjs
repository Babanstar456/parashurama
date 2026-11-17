// Frame rate of the full web app (the build the judges play on Vercel), per view, in a VISIBLE Chromium window
// (headless rendering is not representative): the menus, a radar drill, the 3D field drill (L70, normal view and
// through the sight), and the urban patrol driving through the town.
//   npm run fps:web -- --url https://<your-vercel-app>      (or a local build: npm run build && npx vite preview)
// Flags: --url (default http://localhost:4173), --sec <seconds measured per view> (default 12).
// Prints EVIDENCE lines: average frames per second, the slowest 1% of frames, and draw calls / triangles in the 3D views.
import { chromium } from '@playwright/test';
import { cpus, totalmem } from 'node:os';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const url = arg('--url', 'http://localhost:4173').replace(/\/$/, '');
const sec = Number(arg('--sec', '12'));
// A window behind other windows is slowed to 1 frame a second by Chromium: switch that off so the measure is the machine's.
const browser = await chromium.launch({ headless: false, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'], ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const gpu = await (async () => { const p = await browser.newPage(); await p.goto('about:blank'); const g = await p.evaluate(() => { const c = document.createElement('canvas').getContext('webgl'); const e = c && c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : c ? 'WebGL (renderer hidden)' : 'no WebGL'; }); await p.close(); return g; })();

/** Frames over `sec` seconds: average fps, and the fps of the slowest 1% of frames. `move` runs every 0.5 s (keeps the view busy). */
async function measure(label, move) {
  await page.bringToFront(); await page.waitForLoadState('load'); await page.waitForTimeout(2500); // warm-up: shaders, textures (and any reload after ?reset)
  const r = await page.evaluate(async ([s, hasMove]) => {
    const dts = []; let last = performance.now(); const t0 = last, w = window;
    let k = 0;
    await new Promise((res) => { const f = (t) => { dts.push(t - last); last = t; if (hasMove && t - t0 > k * 500) { k++; w.__move?.(k); } if (t - t0 < s * 1000) requestAnimationFrame(f); else res(0); }; requestAnimationFrame(f); });
    dts.shift();
    // A hidden or covered window is slowed by the OS/browser to one frame a second: those ~1 s frames are not the app's.
    const throttled = dts.filter((d) => d > 900 && d < 1100), ok = dts.filter((d) => !(d > 900 && d < 1100)), span = ok.reduce((a, b) => a + b, 0);
    if (!ok.length || span < s * 250) return { skipped: true, throttledSec: Math.round(throttled.reduce((a, b) => a + b, 0) / 1000) };
    const sorted = [...ok].sort((a, b) => b - a), p1 = sorted.slice(0, Math.max(1, Math.floor(ok.length / 100)));
    return { fps: Math.round((ok.length / (span / 1000)) * 10) / 10, low1: Math.round(1000 / (p1.reduce((a, b) => a + b, 0) / p1.length)), worstMs: Math.round(sorted[0]), throttledSec: Math.round(throttled.reduce((a, b) => a + b, 0) / 1000), measuredSec: Math.round(span / 100) / 10 };
  }, [sec, !!move]);
  if (r.skipped) { console.log(`EVIDENCE fps-web ${label}: not measured (the window was throttled by the OS for ${r.throttledSec} s; keep the browser window in front)`); return; }
  const info = await page.evaluate(() => (window.PARA_GUN?.info?.() ?? null));
  console.log(`EVIDENCE fps-web ${label}: ${r.fps} fps average, slowest 1% ${r.low1} fps, worst frame ${r.worstMs} ms over ${r.measuredSec} s${r.throttledSec ? ` (${r.throttledSec} s of OS window throttling left out)` : ''}${info && label.startsWith('3D') ? `, ${info.calls} draw calls, ${Math.round(info.triangles / 1000)}k triangles` : ''}`);
}

console.log(`EVIDENCE fps-web machine: ${cpus()[0]?.model ?? 'unknown CPU'}, ${cpus().length} threads, ${Math.round(totalmem() / 2 ** 30)} GB RAM, GPU ${gpu}; ${url}`);
// Menus
await page.goto(`${url}/?reset`); await page.waitForTimeout(1500); await page.waitForSelector('#hcPlay', { timeout: 60000 });
await measure('menus (home screen)');
// Radar drill with the 3D view
await page.goto(`${url}/?reset&nohome`); await page.waitForTimeout(1500); await page.waitForFunction(() => window.PARA_GUN, null, { timeout: 60000 });
if (await page.locator('#tourEnd').isVisible().catch(() => false)) await page.click('#tourEnd');
if (await page.locator('#beginBtn').isVisible().catch(() => false)) await page.click('#beginBtn');
await measure('radar drill');
// 3D field drill: L70, looking round the horizon, then through the sight
await page.goto(`${url}/?reset&nohome`); await page.waitForTimeout(1500); await page.waitForFunction(() => window.PARA_GUN, null, { timeout: 60000 });
await page.evaluate(() => window.PARA_GUN.open('field', { gun: 'l70', easy: true }));
await page.waitForFunction(() => window.PARA_GUN.info?.()?.calls > 0, null, { timeout: 90000 });
await page.evaluate(() => { window.__move = (k) => window.PARA_GUN.look((k * 23) % 360, 4 + (k % 5), false, false); });
await measure('3D field drill (L70), looking round', true);
await page.evaluate(() => { window.__move = (k) => window.PARA_GUN.look((k * 11) % 360, 6, false, true); });
await measure('3D field drill (L70), through the thermal sight', true);
// Urban patrol, the AI driving
await page.goto(`${url}/?reset&nohome`); await page.waitForTimeout(1500); await page.waitForFunction(() => window.PARA_PATROL, null, { timeout: 60000 });
await page.evaluate(() => { window.PARA_GUN.open('patrol'); });
await page.waitForFunction(() => window.PARA_PATROL.state()?.tick > 5, null, { timeout: 90000 });
await page.evaluate(() => window.PARA_PATROL.ai(true));
await measure('urban patrol (driving)');
await browser.close();
