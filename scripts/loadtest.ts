// Multi-trainee LAN load test for the unit server.
//
//   npm run loadtest                                  # 30 trainees x 5 drills, in-process server on a free port, temp DATA_DIR
//   npm run loadtest -- --trainees 60 --drills 5
//   npm run loadtest -- --url http://10.0.0.5:8080    # a real unit server on the LAN (add --insecure for a self-signed HTTPS cert)
//
// Every trainee signs in by name (its own cookie session), then all trainees at once submit their drills.
// Each drill is a real decision log played by the expert ghost on that trainee's own seed, so the server's
// re-run (seed + decision log, SHA-256 chain) does the same work it does for a real trainee.
// After each drill the trainee opens its history and readiness, as the AAR screen does.
// An admin polls the unit readiness board throughout, as an instructor would.
// Payloads are built before the clock starts, so client-side simulation is not counted in the timings.
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { chainHash, createEngine, defaultConfig, expertPolicy, isDone, runTotal, scoreRun, step, ticks, type Action, type DrillConfig } from '@parashurama/engine';
import { buildApp } from '../apps/server/src/app';
import { createUser } from '../apps/server/src/auth';

export interface LoadOptions {
  trainees: number; drills: number;
  /** Target a running server instead of starting one in-process. */ url?: string;
  /** Accept a self-signed HTTPS certificate (--url only). */ insecure?: boolean;
  /** Name prefix; trainee names are `${prefix}-01` ... (DPDP-safe demo names). */ prefix?: string;
  /** Pause between one trainee's drills, in ms (0 = worst-case burst). */ thinkMs?: number;
  /** Interval of the admin's unit-board polling, in ms (default 250; 0 = off). */ boardMs?: number;
  /** In-process only: give each trainee its own loopback address (127.0.1.x), as separate LAN machines would have. */ spreadIps?: boolean;
}
export interface Stats { n: number; p50: number; p95: number; max: number; mean: number }
export interface LoadResult {
  target: string; trainees: number; drillsPerTrainee: number;
  submitted: number; accepted: number; rejected: number; errors: number; errorSamples: string[];
  wallMs: number; drillsPerSec: number;
  submit: Stats; history: Stats; readiness: Stats; board: Stats; login: Stats;
  expected: number; stored: number; perTraineeOk: boolean; chainsMatch: number; scoresMatch: number;
}

const pct = (xs: number[]): Stats => {
  const s = [...xs].sort((a, b) => a - b), at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : NaN);
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s.length ? s[s.length - 1] : NaN, mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN };
};
const pad = (i: number) => String(i).padStart(2, '0');

/** Vary the drill conditions across the class (day/night, urban/rural, degraded sensors, swarms), each with its own seed. */
export function drillCfg(trainee: number, drill: number): DrillConfig {
  const k = trainee * 7 + drill;
  return { seed: 100_000 + trainee * 1000 + drill, drill: drill + 1, time: k % 2 ? 'night' : 'day', terrain: (k >> 1) % 2 ? 'urban' : 'rural',
    fault: (['none', 'radar', 'eo', 'rf'] as const)[k % 4], faultSector: (k * 37) % 360, pattern: k % 5 === 4 ? 'swarm' : 'mixed',
    difficulty: 1 + (k % 6), focus: { sector: null, loiter: false, decoy: false } };
}
/** Same construction as apps/server/test/server.test.ts: the expert ghost plays the drill and its decision log is submitted. */
export function expertPayload(cfg: DrillConfig) {
  const E = createEngine(cfg); const actions: Action[] = [];
  while (E.tick < ticks(defaultConfig, 150)) { const a = expertPolicy(E); actions.push(...a); step(E, a); if (isDone(E)) break; }
  return { cfg, actions, endTick: E.tick, attn: new Array(12).fill(1), mode: 'scored', clientTotal: runTotal(scoreRun(E)) };
}

interface Resp { status: number; body: any; cookie?: string }
function client(base: string, opts: { insecure?: boolean; localAddress?: string }) {
  const u = new URL(base), https = u.protocol === 'https:';
  const agent = https ? new HttpsAgent({ keepAlive: true, rejectUnauthorized: !opts.insecure, localAddress: opts.localAddress })
    : new HttpAgent({ keepAlive: true, localAddress: opts.localAddress });
  let cookie = '';
  const call = (method: string, path: string, payload?: unknown) => new Promise<Resp>((res, rej) => {
    const data = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    const req = (https ? httpsRequest : httpRequest)(new URL(path, u), { method, agent, headers: {
      ...(cookie ? { cookie } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c) => chunks.push(c)).on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8'); let body: any = txt;
        try { body = JSON.parse(txt); } catch { /* not JSON */ }
        const sc = r.headers['set-cookie']; if (sc?.length) cookie = sc[0].split(';')[0];
        res({ status: r.statusCode ?? 0, body });
      }).on('error', rej);
    });
    req.on('error', rej); req.setTimeout(60_000, () => req.destroy(new Error('timeout after 60 s')));
    if (data) req.write(data); req.end();
  });
  return { call, close: () => agent.destroy() };
}
const timed = async <T>(xs: number[], f: () => Promise<T>) => { const t = performance.now(); const r = await f(); xs.push(performance.now() - t); return r; };

export async function runLoadTest(o: LoadOptions): Promise<LoadResult> {
  const prefix = o.prefix ?? 'trainee', thinkMs = o.thinkMs ?? 0, boardMs = o.boardMs ?? 250;
  let base = o.url, dir: string | null = null, local: Awaited<ReturnType<typeof buildApp>> | null = null;
  if (!base) {
    dir = mkdtempSync(join(tmpdir(), 'para-load-'));
    local = await buildApp({ dataDir: dir });
    createUser(local.db, { username: 'admin', name: 'Administrator', role: 'admin' }); // as on a server's first start
    base = await local.app.listen({ port: 0, host: '127.0.0.1' });
  }
  const spread = !o.url && (o.spreadIps ?? process.platform === 'linux');
  try {
    // Build every drill before the clock starts.
    const work = Array.from({ length: o.trainees }, (_, t) => Array.from({ length: o.drills }, (_, d) => expertPayload(drillCfg(t, d))));
    const chains = await Promise.all(work.map((ds) => Promise.all(ds.map((p) => chainHash(p.actions)))));

    const L = { submit: [] as number[], history: [] as number[], readiness: [] as number[], board: [] as number[], login: [] as number[] };
    const errs: string[] = []; let errors = 0, accepted = 0, rejected = 0, submitted = 0, chainsMatch = 0, scoresMatch = 0;
    const fail = (what: string, e: unknown) => { errors++; if (errs.length < 5) errs.push(`${what}: ${e instanceof Error ? e.message : String(e)}`); };

    const admin = client(base, { insecure: o.insecure });
    const al = await admin.call('POST', '/api/auth/login', { name: 'admin' });
    if (al.status !== 200) throw new Error(`admin sign-in failed: ${al.status} ${JSON.stringify(al.body)}`);
    const trainees = Array.from({ length: o.trainees }, (_, t) => ({ name: `${prefix}-${pad(t + 1)}`,
      c: client(base!, { insecure: o.insecure, localAddress: spread ? `127.0.1.${t + 1}` : undefined }), before: 0 }));
    // Sign in (each trainee gets its own session cookie) and open the app (config + history), concurrently.
    await Promise.all(trainees.map(async (tr) => {
      try {
        const r = await timed(L.login, () => tr.c.call('POST', '/api/auth/login', { name: tr.name }));
        if (r.status !== 200) throw new Error(`HTTP ${r.status} ${JSON.stringify(r.body)}`);
        if ((await tr.c.call('GET', '/api/config')).status !== 200) throw new Error('config fetch failed');
        tr.before = (await tr.c.call('GET', '/api/drills/mine')).body.drills.length;
      } catch (e) { fail(`login ${tr.name}`, e); }
    }));

    let running = true;
    const board = (async () => {
      while (running && boardMs > 0) {
        try { const r = await timed(L.board, () => admin.call('GET', '/api/readiness')); if (r.status !== 200) fail('board', `HTTP ${r.status}`); } catch (e) { fail('board', e); }
        await new Promise((r) => setTimeout(r, boardMs));
      }
    })();
    const t0 = performance.now();
    await Promise.all(trainees.map(async (tr, t) => {
      for (let d = 0; d < o.drills; d++) {
        try {
          submitted++;
          const r = await timed(L.submit, () => tr.c.call('POST', '/api/drills', work[t][d]));
          if (r.status >= 500 || r.status === 0) { fail(`drill ${tr.name}#${d + 1}`, `HTTP ${r.status} ${JSON.stringify(r.body)}`); continue; }
          if (r.status === 200 && r.body.verified) accepted++; else { rejected++; if (errs.length < 5) errs.push(`rejected ${tr.name}#${d + 1}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); }
          if (r.body?.chain === chains[t][d]) chainsMatch++;
          if (r.body?.total === work[t][d].clientTotal) scoresMatch++;
          const h = await timed(L.history, () => tr.c.call('GET', '/api/drills/mine')); if (h.status !== 200) fail('history', `HTTP ${h.status}`);
          const g = await timed(L.readiness, () => tr.c.call('GET', '/api/readiness')); if (g.status !== 200) fail('readiness', `HTTP ${g.status}`);
        } catch (e) { fail(`drill ${tr.name}#${d + 1}`, e); }
        if (thinkMs) await new Promise((r) => setTimeout(r, thinkMs));
      }
    }));
    const wallMs = performance.now() - t0;
    running = false; await board;

    // No lost writes: every trainee has exactly its drills, numbered 1..n without gaps or duplicates.
    const expected = o.trainees * o.drills;
    let stored = 0, perTraineeOk = true;
    for (const tr of trainees) {
      const mine = (await tr.c.call('GET', '/api/drills/mine')).body?.drills ?? [];
      const got = mine.length - tr.before; stored += got;
      const ns = mine.slice(tr.before).map((r: any) => r.n), want = Array.from({ length: o.drills }, (_, i) => tr.before + i + 1);
      if (got !== o.drills || JSON.stringify(ns) !== JSON.stringify(want)) perTraineeOk = false;
    }
    if (local) // In-process: count straight from the database rather than trusting the API.
      stored = (local.db.prepare(`SELECT COUNT(*) AS n FROM drills d JOIN users u ON u.id=d.user_id WHERE u.username LIKE ?`).get(`${prefix}-%`) as any).n;
    for (const tr of trainees) tr.c.close(); admin.close();
    return { target: o.url ? base : `in-process ${base}${spread ? ' (one loopback IP per trainee)' : ''}`, trainees: o.trainees, drillsPerTrainee: o.drills,
      submitted, accepted, rejected, errors, errorSamples: errs, wallMs, drillsPerSec: submitted / (wallMs / 1000),
      submit: pct(L.submit), history: pct(L.history), readiness: pct(L.readiness), board: pct(L.board), login: pct(L.login),
      expected, stored, perTraineeOk, chainsMatch, scoresMatch };
  } finally {
    if (local) { await local.app.close(); local.db.close(); }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const ms = (s: Stats) => `p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, max ${s.max.toFixed(1)} ms (n=${s.n})`;
export function evidenceLines(r: LoadResult): string[] {
  return [
    `EVIDENCE loadtest setup: ${r.trainees} trainees x ${r.drillsPerTrainee} drills, all concurrent, against ${r.target}`,
    `EVIDENCE loadtest drills: submitted ${r.submitted}, accepted ${r.accepted}, rejected ${r.rejected}, errors ${r.errors}; server score = expert score ${r.scoresMatch}/${r.submitted}, SHA-256 chain matches ${r.chainsMatch}/${r.submitted}`,
    `EVIDENCE loadtest wall time ${(r.wallMs / 1000).toFixed(2)} s, throughput ${r.drillsPerSec.toFixed(1)} drills/s (incl. history + readiness fetch after each drill)`,
    `EVIDENCE loadtest drill submit (server re-run + store) latency: ${ms(r.submit)}`,
    `EVIDENCE loadtest trainee readiness fetch latency: ${ms(r.readiness)}; history fetch: ${ms(r.history)}`,
    `EVIDENCE loadtest unit readiness board (admin, polled during load) latency: ${ms(r.board)}`,
    `EVIDENCE loadtest sign-in latency: ${ms(r.login)}`,
    `EVIDENCE loadtest no lost writes: stored ${r.stored}/${r.expected} drills, per-trainee numbering 1..${r.drillsPerTrainee} ${r.perTraineeOk ? 'intact' : 'BROKEN'}`,
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), get = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const num = (k: string, d: number) => { const v = get(k); if (v == null) return d; const n = Number(v); if (!Number.isInteger(n) || n < 0) { console.error(`--${k} must be a whole number`); process.exit(2); } return n; };
  process.removeAllListeners('warning');
  const r = await runLoadTest({ trainees: num('trainees', 30), drills: num('drills', 5), url: get('url'), insecure: args.includes('--insecure'),
    prefix: get('prefix'), thinkMs: num('think', 0), boardMs: num('board', 250), spreadIps: args.includes('--one-ip') ? false : undefined });
  for (const l of evidenceLines(r)) console.log(l);
  for (const e of r.errorSamples) console.log(`  sample: ${e}`);
  const ok = r.errors === 0 && r.rejected === 0 && r.stored === r.expected && r.perTraineeOk;
  console.log(ok ? 'loadtest: PASS' : 'loadtest: FAIL');
  process.exit(ok ? 0 : 1);
}
