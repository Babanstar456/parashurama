import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, defaultConfig, expertPolicy, isDone, runTotal, scoreRun, step, ticks, type Action, type DrillConfig } from '@parashurama/engine';
import { buildApp } from '../src/app';
import { createUser } from '../src/auth';

let dir: string, app: Awaited<ReturnType<typeof buildApp>>['app'], db: any;
const cookies: Record<string, string> = {};
const call = (method: string, url: string, who?: string, payload?: any, headers: any = {}) =>
  app.inject({ method: method as any, url, payload, headers: { ...(who ? { cookie: cookies[who] } : {}), ...headers } });
async function login(who: string) {
  const r = await call('POST', '/api/auth/login', undefined, { name: who });
  expect(r.statusCode).toBe(200);
  cookies[who] = String(r.headers['set-cookie']).split(';')[0];
}
const cfg: DrillConfig = { seed: 4242, drill: 1, time: 'day', terrain: 'rural', fault: 'none', faultSector: 0, pattern: 'mixed', difficulty: 3, focus: { sector: null, loiter: false, decoy: false } };
function expertDrill() {
  const E = createEngine(cfg); const actions: Action[] = [];
  while (E.tick < ticks(defaultConfig, 150)) { const a = expertPolicy(E); actions.push(...a); step(E, a); if (isDone(E)) break; }
  return { actions, endTick: E.tick, total: runTotal(scoreRun(E)) };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'para-'));
  ({ app, db } = await buildApp({ dataDir: dir }));
  createUser(db, { username: 'admin', name: 'Admin', role: 'admin' });
  createUser(db, { username: 'inst', name: 'Instructor', role: 'instructor' });
  createUser(db, { username: 'sep', name: 'Sep Test', role: 'trainee' });
  await login('admin'); await login('inst'); await login('sep');
});
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

describe('unit server', () => {
  it('reports health and sends security headers', async () => {
    const r = await call('GET', '/api/health');
    expect(r.json()).toMatchObject({ ok: true, mode: 'server' });
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('signs in by name only: matches existing accounts and creates new trainees', async () => {
    const byName = (await call('POST', '/api/auth/login', undefined, { name: '  sep   TEST ' })).json().user;
    expect(byName).toMatchObject({ username: 'sep', role: 'trainee' });
    const fresh = await call('POST', '/api/auth/login', undefined, { name: 'Hav Singh' });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().user).toMatchObject({ username: 'hav.singh', name: 'Hav Singh', role: 'trainee' });
    expect((await call('POST', '/api/auth/login', undefined, { name: 'hav singh' })).json().user.id).toBe(fresh.json().user.id);
    expect((await call('POST', '/api/auth/login', undefined, { name: '' })).statusCode).toBe(400);
    expect((await call('POST', '/api/auth/login', undefined, { name: '!!' })).statusCode).toBe(400);
  });

  it('requires a session and enforces roles', async () => {
    expect((await call('GET', '/api/me')).statusCode).toBe(401);
    expect((await call('GET', '/api/me', 'sep')).json().user).toMatchObject({ username: 'sep', role: 'trainee' });
    expect((await call('PUT', '/api/config', 'sep', { config: defaultConfig })).statusCode).toBe(403);
    expect((await call('GET', '/api/users', 'inst')).statusCode).toBe(403);
  });

  it('refuses cross-origin state changes', async () => {
    const r = await call('PUT', '/api/me/settings', 'sep', {}, { origin: 'http://evil.example', host: 'parashurama.local' });
    expect(r.statusCode).toBe(403);
  });

  it('versions doctrine config and rejects invalid edits with readable errors', async () => {
    const bad = JSON.parse(JSON.stringify(defaultConfig)); bad.effectors.effectors.jam.min = 5000;
    const r1 = await call('PUT', '/api/config', 'inst', { config: bad });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().errors.join()).toMatch(/min >= range/);
    const good = JSON.parse(JSON.stringify(defaultConfig)); good.training.certification.passMark = 80;
    const r2 = await call('PUT', '/api/config', 'inst', { config: good, note: 'raise pass mark' });
    expect(r2.statusCode).toBe(200);
    const g = (await call('GET', '/api/config', 'sep')).json();
    expect(g.custom).toBe(true);
    expect(g.config.training.certification.passMark).toBe(80);
    expect((await call('GET', '/api/config/history', 'inst')).json().versions[0].note).toBe('raise pass mark');
  });

  it('re-runs submitted drills and stores the server score', async () => {
    const d = expertDrill();
    const r = await call('POST', '/api/drills', 'sep', { cfg, actions: d.actions, endTick: d.endTick, attn: new Array(12).fill(1), mode: 'scored', clientTotal: d.total });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.total).toBe(d.total);
    expect(b.verified).toBe(true);
    expect(b.chain).toMatch(/^[0-9a-f]{64}$/);
    const mine = (await call('GET', '/api/drills/mine', 'sep')).json().drills;
    expect(mine).toHaveLength(1);
    expect(mine[0].total).toBe(d.total);
    expect(mine[0].obs.detect.length).toBeGreaterThan(0);
  });

  it('accepts and re-scores a drill with clearance requests under peacetime ROE', async () => {
    const pc: DrillConfig = { ...cfg, seed: 777, roe: 'peacetime' };
    const E = createEngine(pc); const actions: Action[] = [];
    while (E.tick < ticks(defaultConfig, 150)) { const a = expertPolicy(E); actions.push(...a); step(E, a); if (isDone(E)) break; }
    expect(actions.some((a) => a.k === 'req')).toBe(true);
    const r = await call('POST', '/api/drills', 'inst', { cfg: pc, actions, endTick: E.tick, mode: 'scored', clientTotal: runTotal(scoreRun(E)) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ verified: true, total: runTotal(scoreRun(E)) });
    expect((await call('POST', '/api/drills', 'inst', { cfg: { ...pc, roe: 'wartime' }, actions: [], endTick: 10 })).statusCode).toBe(400);
  });

  it('never trusts a claimed score', async () => {
    const d = expertDrill();
    const r = (await call('POST', '/api/drills', 'sep', { cfg, actions: d.actions.slice(0, 3), endTick: d.endTick, mode: 'scored', clientTotal: 100 })).json();
    expect(r.verified).toBe(false);
    expect(r.flags).toContain('client-score-mismatch');
    expect(r.total).toBeLessThan(100);
  });

  it('rejects malformed drill payloads', async () => {
    const r1 = await call('POST', '/api/drills', 'sep', { cfg, actions: [{ tick: 5, k: 'id', cid: 1, cls: 'ufo', conf: 0.8 }], endTick: 100 });
    expect(r1.statusCode).toBe(400); expect(r1.json().error).toMatch(/cls/);
    const r2 = await call('POST', '/api/drills', 'sep', { cfg: { ...cfg, difficulty: 99 }, actions: [], endTick: 100 });
    expect(r2.statusCode).toBe(400);
    const r3 = await call('POST', '/api/drills', 'sep', { cfg, actions: [{ tick: 9, k: 'track', cid: 1 }, { tick: 2, k: 'track', cid: 2 }], endTick: 100 });
    expect(r3.json().error).toMatch(/time order/);
  });

  it('builds the readiness board from verified records, scoped by role', async () => {
    const inst = (await call('GET', '/api/readiness', 'inst')).json().operators;
    const sep = inst.find((o: any) => o.name === 'Sep Test');
    expect(sep.drills).toBe(2);
    expect(sep.mastery.detect).toBeGreaterThan(0);
    const own = (await call('GET', '/api/readiness', 'sep')).json().operators;
    expect(own).toHaveLength(1);
  });

  it('lets instructors publish scripted drills and validates them', async () => {
    const bad = await call('POST', '/api/templates', 'inst', { name: 'X', cfg: { time: 'day', terrain: 'rural', fault: 'none', pattern: 'mixed' }, spawns: [{ type: 'dragon', t: 0, brg: 0 }] });
    expect(bad.statusCode).toBe(400);
    const ok = await call('POST', '/api/templates', 'inst', { name: 'Exam 1', cfg: { time: 'night', terrain: 'urban', fault: 'rf', pattern: 'mixed' }, spawns: [{ type: 'fpv', t: 0, brg: 90, dist: 2500 }] });
    expect(ok.statusCode).toBe(200);
    expect((await call('GET', '/api/templates', 'sep')).json().templates[0]).toMatchObject({ name: 'Exam 1', cfg: { time: 'night' } });
    expect((await call('POST', '/api/templates', 'sep', { name: 'Y', cfg: {}, spawns: [] })).statusCode).toBe(403);
    expect((await call('DELETE', `/api/templates/${ok.json().id}`, 'inst')).statusCode).toBe(200);
  });

  it('lets admins create users and refuses duplicates and bad input', async () => {
    expect((await call('POST', '/api/users', 'admin', { username: 'nk.rao', name: 'Nk Rao', role: 'trainee' })).statusCode).toBe(200);
    expect((await call('POST', '/api/users', 'admin', { username: 'nk.rao', name: 'Nk Rao', role: 'trainee' })).statusCode).toBe(409);
    expect((await call('POST', '/api/users', 'admin', { username: 'x', name: 'S', role: 'trainee' })).statusCode).toBe(400);
    expect((await call('POST', '/api/users', 'admin', { username: 'cmdr.lal', name: 'Cmdr Lal', role: 'general' })).statusCode).toBe(400);
  });

  it('takes consistent backups and keeps an audit trail', async () => {
    const file = (await call('POST', '/api/admin/backup', 'admin')).json().file;
    expect(existsSync(file)).toBe(true);
    const ev = (await call('GET', '/api/admin/audit', 'admin')).json().events.map((e: any) => e.action);
    expect(ev).toEqual(expect.arrayContaining(['login', 'user-create', 'config-update', 'drill-flagged', 'backup']));
  });

  it('returns 4xx (not 500) for an empty JSON body', async () => {
    const r = await call('POST', '/api/admin/backup', 'admin', undefined, { 'content-type': 'application/json' });
    expect(r.statusCode).toBeLessThan(500);
  });

  it('logging out ends the session', async () => {
    await call('POST', '/api/auth/logout', 'sep', undefined, { 'content-type': 'application/json' });
    expect((await call('GET', '/api/me', 'sep')).statusCode).toBe(401);
  });
});
