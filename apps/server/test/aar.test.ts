import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  controlRoomAI, createEngine, createPatrol, defaultConfig, defaultGunCfg, defaultPatrolCfg, driveGun, createGun, expertPolicy, gunCrewAI, isDone, patrolAI, patrolDone,
  patrolMaxTicks, runTotal, scoreField, scorePatrol, scoreRun, step, stepPatrol, ticks, type Action, type DrillConfig, type PatrolAction,
} from '@parashurama/engine';
import { buildApp } from '../src/app';
import { createUser } from '../src/auth';
import { loadPatrolWorld } from '../src/patrol';

/** After-action review across every drill kind: patrol drills are re-run and stored; one CSV covers radar, gun and patrol. */
let dir: string, app: Awaited<ReturnType<typeof buildApp>>['app'], db: any;
const cookies: Record<string, string> = {};
const call = (method: string, url: string, who: string, payload?: any) => app.inject({ method: method as any, url, payload, headers: { cookie: cookies[who] } });
const W = loadPatrolWorld()!;

/** An expert patrol, recorded the way the browser records it (actions stamped with the tick they were applied). */
function patrolDrill(seed: number) {
  const E = createPatrol(defaultPatrolCfg({ seed }), W), actions: PatrolAction[] = [];
  while (E.tick < patrolMaxTicks(E) && !patrolDone(E)) { const a = patrolAI(E).map((x) => ({ ...x, tick: E.tick })); actions.push(...a); stepPatrol(E, a); }
  return { cfg: E.cfg, actions, endTick: E.tick, clientTotal: scorePatrol(E).total };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'para-aar-'));
  ({ app, db } = await buildApp({ dataDir: dir, dataKey: randomBytes(32) }));
  createUser(db, { username: 'admin', name: 'Admin', role: 'admin' });
  createUser(db, { username: 'tr-01', name: 'Trainee 01', role: 'trainee' });
  for (const who of ['admin', 'tr-01']) { const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { name: who } }); cookies[who] = String(r.headers['set-cookie']).split(';')[0]; }
});
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

describe('after-action review across all drills', () => {
  it('the server finds the patrol town', () => { expect(W?.boxes.length).toBeGreaterThan(10); });
  it('patrol drills are re-run from the log and stored; a faked score is flagged and the server total kept', async () => {
    const d = patrolDrill(5);
    const ok = await call('POST', '/api/patrol/drills', 'tr-01', d);
    expect(ok.statusCode).toBe(200); expect(ok.json().verified).toBe(true); expect(ok.json().total).toBe(d.clientTotal);
    const fake = await call('POST', '/api/patrol/drills', 'tr-01', { ...d, clientTotal: d.clientTotal - 7 });
    expect(fake.json().verified).toBe(false); expect(fake.json().flags).toContain('client-score-mismatch'); expect(fake.json().total).toBe(d.clientTotal);
    expect((await call('POST', '/api/patrol/drills', 'tr-01', { ...d, actions: [{ tick: 1, k: 'teleport' }] })).statusCode).toBe(400);
    const mine = (await call('GET', '/api/patrol/drills/mine', 'tr-01')).json().drills;
    expect(mine.length).toBe(2); expect(mine[0].total).toBe(d.clientTotal);
    const board = (await call('GET', '/api/patrol/readiness', 'admin')).json().operators.find((o: any) => o.name === 'Trainee 01');
    expect(board.drills).toBe(2); expect(board.totals).toEqual([d.clientTotal, d.clientTotal]);
  });
  it('one CSV lists radar, gun and patrol drills; a trainee gets only their own', async () => {
    const cfg: DrillConfig = { seed: 77, drill: 1, time: 'day', terrain: 'rural', fault: 'none', faultSector: 0, pattern: 'mixed', difficulty: 2, focus: { sector: null, loiter: false, decoy: false } };
    const E = createEngine(cfg), actions: Action[] = [];
    while (E.tick < ticks(defaultConfig, 150)) { const a = expertPolicy(E); actions.push(...a); step(E, a); if (isDone(E)) break; }
    expect((await call('POST', '/api/drills', 'tr-01', { cfg, actions, endTick: E.tick, mode: 'scored', clientTotal: runTotal(scoreRun(E)) })).statusCode).toBe(200);
    const gcfg = defaultGunCfg({ seed: 3, gun: 'l70', selfId: true, difficulty: 1, attack: true, leadOnly: true }), G = createGun(gcfg), log = driveGun(G, [controlRoomAI, (x) => gunCrewAI(x)]);
    const gr = await call('POST', '/api/gun/drills', 'tr-01', { game: 'field', cfg: gcfg, actions: log, endTick: G.tick, clientTotal: scoreField(G).total });
    expect(gr.statusCode).toBe(200);
    const csv = (await call('GET', '/api/export/all.csv', 'tr-01')).body.trim().split('\r\n');
    expect(csv[0]).toBe('operator,unit,kind,date,gun,time,terrain,weather,difficulty,seed,total,pass,verified,hostiles_destroyed,hostiles,position_struck');
    const kinds = csv.slice(1).map((l) => l.split(',')[2]);
    expect(kinds.filter((k) => k === 'patrol').length).toBe(2); expect(kinds).toContain('radar'); expect(kinds).toContain('field');
    expect(csv.slice(1).every((l) => l.startsWith('Trainee 01,'))).toBe(true);
    expect((await call('GET', '/api/export/all.csv', 'admin')).body.trim().split('\r\n').length).toBe(csv.length);
  });
});
