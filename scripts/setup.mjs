// One-step setup and start, called by setup.sh / setup.bat (Node.js 22.5+ is already checked by them).
//  1. Dependencies: installs them on the first run, and again only when package-lock.json has changed.
//  2. Build: builds the web app and the unit server when a build is missing or older than the sources.
//  3. Run: starts the unit server (http://localhost:8080), waits until it answers and opens the browser.
// Options: --offline   web app only, no unit server (http://localhost:5173)
//          --port N    unit server port (default 8080)
//          --rebuild   build even if the build looks current
//          --check     install and build only, do not start
//          --no-open   do not open the browser
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const port = Number(args[args.indexOf('--port') + 1]) || Number(process.env.PORT) || 8080;
const win = process.platform === 'win32';
const npm = win ? 'npm.cmd' : 'npm';
const say = (s) => console.log(`\x1b[36m[setup]\x1b[0m ${s}`);
const fail = (s) => { console.error(`\x1b[31m[setup] ${s}\x1b[0m`); process.exit(1); };
const run = (cmd, a) => { const r = spawnSync(cmd, a, { stdio: 'inherit', shell: win }); return r.status === 0; };

// ---------- 1. dependencies ----------
const lockHash = createHash('sha256').update(readFileSync('package-lock.json')).digest('hex');
const stamp = join('node_modules', '.parashurama-setup');
const installed = existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === lockHash && existsSync(join('node_modules', 'vite')) && existsSync(join('node_modules', 'fastify'));
if (installed) say('Dependencies: up to date.');
else {
  say(existsSync('node_modules') ? 'Dependencies changed: reinstalling (npm ci)…' : 'First run: installing dependencies (npm ci, a few minutes)…');
  if (!run(npm, ['ci', '--no-audit', '--no-fund'])) {
    say('npm ci failed; trying npm install…');
    if (!run(npm, ['install', '--no-audit', '--no-fund'])) fail('Could not install the dependencies. Check the internet connection and run setup again.');
  }
  writeFileSync(stamp, lockHash);
  say('Dependencies installed.');
}

// ---------- 2. build ----------
const newest = (p) => {
  if (!existsSync(p)) return 0;
  const s = statSync(p); if (!s.isDirectory()) return s.mtimeMs;
  let m = 0; for (const e of readdirSync(p)) m = Math.max(m, newest(join(p, e))); return m;
};
if (!has('--offline')) {
  const outputs = ['apps/web/dist/index.html', 'apps/server/dist/server.mjs'];
  const builtAt = Math.min(...outputs.map((f) => (existsSync(f) ? statSync(f).mtimeMs : 0)));
  const srcAt = Math.max(...['apps/web/src', 'apps/web/public', 'apps/web/index.html', 'apps/server/src', 'packages/engine/src', 'config', 'package-lock.json'].map(newest));
  if (!has('--rebuild') && builtAt && builtAt >= srcAt) say('Build: up to date.');
  else {
    say(builtAt ? 'Sources changed: rebuilding…' : 'Building the web app and the unit server…');
    if (!run(npm, ['run', 'build'])) fail('The build failed (see above).');
    say('Build done.');
  }
}
if (has('--check')) { say('Setup complete. Run setup again (without --check) to start the app.'); process.exit(0); }

// ---------- 3. run ----------
const url = has('--offline') ? 'http://localhost:5173' : `http://localhost:${port}`;
const openBrowser = () => {
  if (has('--no-open')) return;
  const [c, a] = win ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(c, a, { stdio: 'ignore', detached: true, shell: false }).unref(); } catch { /* no browser: the URL is printed */ }
};
// The app runs in its own process group, so stopping setup (Ctrl+C, closing the terminal, kill) always stops the
// server and everything npm started with it; a stale server never keeps the port.
const opts = { stdio: ['ignore', 'inherit', 'inherit'], shell: win, detached: !win };
const child = has('--offline')
  ? spawn(npm, ['run', 'dev', '-w', '@parashurama/web', '--', '--port', '5173', '--strictPort'], opts)
  : spawn(npm, ['run', 'server'], { ...opts, env: { ...process.env, PORT: String(port) } });
let stopping = false;
const stop = () => {
  if (stopping) return; stopping = true;
  say('Stopping…');
  if (win) { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); return; }
  try { process.kill(-child.pid, 'SIGINT'); } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(0); }, 5000).unref();
};
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, stop);
child.on('exit', (code) => process.exit(stopping ? 0 : code ?? 0));

// Wait until the app answers, then open it and show the addresses for other PCs on the network.
const t0 = Date.now();
const poll = async () => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.ok || r.status < 500) return true; } catch { /* not up yet */ }
  return false;
};
(async () => {
  while (Date.now() - t0 < 60000) { if (await poll()) break; await new Promise((r) => setTimeout(r, 700)); }
  const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('');
  say(`PARASHURAMA is running: \x1b[1m${url}\x1b[0m`);
  if (!has('--offline')) for (const ip of lan) say(`Other PCs on this network: http://${ip}:${port}`);
  say('Press Ctrl+C to stop.');
  openBrowser();
})();
