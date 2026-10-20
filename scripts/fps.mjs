// Frame-rate check for the presentation laptop: `npm run fps` (after `npm run build:single`).
// Opens the offline single-file app in a VISIBLE Chromium window (headless rendering is not representative),
// spends a fixed time in the menus, in a drill with the radar, and with the 3D view expanded, then prints
// the ?fps meter's per-view report as EVIDENCE lines.
// Flags: --file <path to index.html> (default apps/web/dist-single/index.html), --sec <seconds per view> (default 15).
// Without Node on the laptop: open docs/index.html?fps in a browser, use the app, and click the meter to copy the same report.
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const file = resolve(arg('--file', 'apps/web/dist-single/index.html'));
const sec = Number(arg('--sec', '15'));
if (!existsSync(file)) { console.error(`Not found: ${file}. Run npm run build:single first.`); process.exit(1); }

const browser = await chromium.launch({ headless: false, ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}) });
const page = await browser.newPage({ viewport: null });
await page.goto(pathToFileURL(file).href + '?fps&reset&nohome');
await page.click('#tourEnd');
await page.waitForTimeout(sec * 1000);
await page.click('#beginBtn');
await page.evaluate(() => localStorage.removeItem('parashurama.3dmin'));
await page.waitForTimeout(sec * 1000);
const has3d = await page.locator('#view3d canvas').count();
if (has3d) { await page.keyboard.press('v'); await page.waitForTimeout(sec * 1000); }
const report = await page.evaluate(() => window.fpsReport());
await browser.close();

const [head, ...rows] = report.split('\n');
console.log(`EVIDENCE fps machine: ${cpus()[0]?.model ?? 'unknown CPU'}, ${cpus().length} threads, ${Math.round(totalmem() / 2 ** 30)} GB RAM`);
console.log(`EVIDENCE fps ${head}`);
for (const r of rows) console.log(`EVIDENCE fps ${r}`);
if (!has3d) console.log('EVIDENCE fps 3D view: no WebGL in this browser, so only the 2D radar was measured');
