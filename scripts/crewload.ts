/**
 * Crew-drill load check for the unit server: N crew drills at once at the real 10 Hz clock, each watched by two
 * Server-Sent-Event clients (one per seat), seats played by the AI. Measures whether the server keeps time.
 *   npm run crewload -- --crews 10 --sec 20
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { buildApp } from '../apps/server/src/app';
import { createUser } from '../apps/server/src/auth';

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
export async function crewLoad(crews: number, sec: number) {
  const dir = mkdtempSync(join(tmpdir(), 'para-crew-'));
  const { app, db } = await buildApp({ dataDir: dir });
  createUser(db, { username: 'admin', name: 'Admin', role: 'admin' });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { name: 'admin' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const post = (url: string, body: unknown = {}) => app.inject({ method: 'POST', url, payload: body as any, headers: { cookie } }).then((r) => r.json());
  const rooms: string[] = [];
  for (let i = 0; i < crews; i++) rooms.push((await post('/api/crews', { cfg: { seed: 1000 + i, gun: i % 2 ? 'zsu234' : 'zu23', time: 'day', terrain: 'rural', difficulty: 4, issueRounds: 1000, stoppages: true, met: { tempC: 30, pressureHpa: 1005, wind: [3, 0, 0], latitudeDeg: 26 } } })).code);
  // Two listeners per crew; record the arrival time of every tick.
  const gaps: number[] = [], counts = new Map<string, number>(), reqs: any[] = [];
  for (const code of rooms) for (let k = 0; k < 2; k++) {
    let last = 0;
    const rq = request(`${base}/api/crews/${code}/events`, { headers: { cookie } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        const n = (c.match(/event: tick/g) ?? []).length; if (!n) return;
        const now = performance.now(); if (last) gaps.push(now - last); last = now;
        counts.set(`${code}:${k}`, (counts.get(`${code}:${k}`) ?? 0) + n);
      });
    });
    rq.on('error', () => undefined); rq.end(); reqs.push(rq);
  }
  await new Promise((r) => setTimeout(r, 300));
  const t0 = performance.now(), cpu0 = process.cpuUsage();
  for (const code of rooms) await post(`/api/crews/${code}/start`);
  await new Promise((r) => setTimeout(r, sec * 1000));
  const wall = (performance.now() - t0) / 1000, cpu = process.cpuUsage(cpu0);
  for (const code of rooms) await post(`/api/crews/${code}/end`);
  for (const rq of reqs) rq.destroy();
  await app.close(); rmSync(dir, { recursive: true, force: true });
  const per = [...counts.values()], expected = wall * 10;
  gaps.sort((a, b) => a - b);
  const p = (q: number) => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))] ?? 0;
  return { crews, clients: crews * 2, wall, minTicks: Math.min(...per), expected, keep: Math.min(...per) / expected, p50: p(0.5), p99: p(0.99), max: gaps.at(-1) ?? 0, cpuPct: (cpu.user + cpu.system) / 1e6 / wall * 100 };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await crewLoad(arg('--crews', 10), arg('--sec', 20));
  console.log(`EVIDENCE crewload ${r.crews} crew drills at once (${r.clients} event-stream clients), ${r.wall.toFixed(1)} s, ${cpus()[0]?.model}: slowest client received ${r.minTicks} of ~${Math.round(r.expected)} ticks (${Math.round(r.keep * 100)}% of real time)`);
  console.log(`EVIDENCE crewload tick spacing at the client: p50 ${r.p50.toFixed(0)} ms, p99 ${r.p99.toFixed(0)} ms, max ${r.max.toFixed(0)} ms; server process CPU ${r.cpuPct.toFixed(0)}% of one core`);
}
