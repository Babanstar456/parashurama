import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, defaultConfig, expertPolicy, isDone, runTotal, scoreRun, step, ticks, type Action, type DrillConfig } from '@parashurama/engine';
import { buildApp } from '../src/app';
import { createUser } from '../src/auth';

let dir: string, app: Awaited<ReturnType<typeof buildApp>>['app'], db: any, cookie = '';
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'para-measures-'));
  ({ app, db } = await buildApp({ dataDir: dir }));
  createUser(db, { username: 'sep', name: 'Sep Test', role: 'trainee' });
  cookie = String((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { name: 'sep' } })).headers['set-cookie']).split(';')[0];
});
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

describe('radar drills with control measures on the unit server', () => {
  it('re-verifies a drill with WCS, a safe arc and kill reports, keeping the measures in the stored record', async () => {
    const cfg: DrillConfig = { seed: 4243, drill: 2, time: 'day', terrain: 'urban', fault: 'none', faultSector: 0, pattern: 'mixed', difficulty: 3,
      focus: { sector: null, loiter: false, decoy: false }, wcs: 'hold', safeArcs: [[100, 140]], killAssess: true };
    const E = createEngine(cfg), actions: Action[] = [];
    while (E.tick < ticks(defaultConfig, 150)) { const a = expertPolicy(E); actions.push(...a); step(E, a); if (isDone(E)) break; }
    for (let i = 0; i < 20; i++) { const a = expertPolicy(E); actions.push(...a); step(E, a); } // let the last kill be reported
    expect(actions.some((a) => a.k === 'bda')).toBe(true);
    const total = runTotal(scoreRun(E));
    const r = await app.inject({ method: 'POST', url: '/api/drills', headers: { cookie }, payload: { cfg, actions, endTick: E.tick, mode: 'scored', clientTotal: total } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ total, verified: true });
    const mine = (await app.inject({ method: 'GET', url: '/api/drills/mine', headers: { cookie } })).json().drills.at(-1);
    expect(mine.cfg).toMatchObject({ wcs: 'hold', safeArcs: [[100, 140]], killAssess: true });
  });
});
