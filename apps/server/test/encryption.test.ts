// Training records at rest: drill records and decision logs are AES-256-GCM encrypted when a data key is set.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, defaultConfig, expertPolicy, isDone, runTotal, scoreRun, step, ticks, type Action, type DrillConfig } from '@parashurama/engine';
import { buildApp, encryptExisting } from '../src/app';
import { createUser } from '../src/auth';
import { loadDataKey, open, seal } from '../src/crypto';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'para-enc-')); dirs.push(d); return d; };
const key = randomBytes(32);
const cfg = (seed: number): DrillConfig => ({ seed, drill: 1, time: 'day', terrain: 'rural', fault: 'none', faultSector: 0, pattern: 'mixed', difficulty: 3, focus: { sector: null, loiter: false, decoy: false } });
function drill(seed: number) {
  const E = createEngine(cfg(seed)); const actions: Action[] = [];
  while (E.tick < ticks(defaultConfig, 150)) { const a = expertPolicy(E); actions.push(...a); step(E, a); if (isDone(E)) break; }
  return { cfg: cfg(seed), actions, endTick: E.tick, mode: 'scored', clientTotal: runTotal(scoreRun(E)) };
}
async function session(app: any, name: string) { return String((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { name } })).headers['set-cookie']).split(';')[0]; }
const post = async (app: any, who: string, seed: number) => app.inject({ method: 'POST', url: '/api/drills', headers: { cookie: await session(app, who) }, payload: drill(seed) });
const mine = async (app: any, who: string) => (await app.inject({ method: 'GET', url: '/api/drills/mine', headers: { cookie: await session(app, who) } })).json().drills;

describe('encryption at rest (item 10)', () => {
  it('seal/open round-trips, rejects a wrong key, and passes old plaintext through', () => {
    const s = seal('{"total":91}', key);
    expect(s).toMatch(/^v1:/);
    expect(s).not.toContain('total');
    expect(open(s, key)).toBe('{"total":91}');
    expect(() => open(s, randomBytes(32))).toThrow();
    expect(() => open(s, null)).toThrow(/encrypted/);
    expect(open('{"total":91}', key)).toBe('{"total":91}');
  });

  it('stores drill records and decision logs encrypted; history, restart and CSV export still work', async () => {
    const dir = tmp();
    let { app, db } = await buildApp({ dataDir: dir, dataKey: key });
    createUser(db, { username: 'sep.enc', name: 'Sep Enc', role: 'trainee' });
    for (const s of [21, 22]) expect((await post(app, 'sep.enc', s)).json().verified).toBe(true);
    const raw = db.prepare('SELECT record, actions FROM drills').all() as any[];
    expect(raw.every((r) => r.record.startsWith('v1:') && r.actions.startsWith('v1:'))).toBe(true);
    expect(raw.some((r) => r.record.includes('"total"') || r.actions.includes('"tick"'))).toBe(false);
    await app.close(); db.close();
    ({ app, db } = await buildApp({ dataDir: dir, dataKey: key }));
    expect(await mine(app, 'sep.enc')).toHaveLength(2);
    const csv = (await app.inject({ method: 'GET', url: '/api/export/drills.csv', headers: { cookie: await session(app, 'sep.enc') } })).body.trim().split('\r\n');
    expect(csv).toHaveLength(3);
    await app.close(); db.close();
  });

  it('migrates old plaintext rows; mixed rows stay readable during the transition', async () => {
    const dir = tmp();
    let { app, db } = await buildApp({ dataDir: dir });
    createUser(db, { username: 'sep.old', name: 'Sep Old', role: 'trainee' });
    await post(app, 'sep.old', 31);
    await app.close(); db.close();
    ({ app, db } = await buildApp({ dataDir: dir, dataKey: key }));
    await post(app, 'sep.old', 32);
    expect(await mine(app, 'sep.old')).toHaveLength(2);           // one plaintext, one sealed
    expect(encryptExisting(db, key)).toBe(1);
    expect(encryptExisting(db, key)).toBe(0);                     // safe to run twice
    expect((db.prepare('SELECT record FROM drills').all() as any[]).every((r) => r.record.startsWith('v1:'))).toBe(true);
    expect(await mine(app, 'sep.old')).toHaveLength(2);
    await app.close(); db.close();
  });

  it('loads the key from the environment or a key file outside the data directory', () => {
    const dir = tmp(), outside = tmp(), b64 = key.toString('base64');
    expect(loadDataKey({ PARASHURAMA_DATA_KEY: b64 }, dir)).toEqual(key);
    expect(loadDataKey({}, dir)).toBeNull();
    writeFileSync(join(outside, 'k'), b64 + '\n');
    expect(loadDataKey({ PARASHURAMA_DATA_KEY_FILE: join(outside, 'k') }, dir)).toEqual(key);
    writeFileSync(join(dir, 'k'), b64);
    expect(() => loadDataKey({ PARASHURAMA_DATA_KEY_FILE: join(dir, 'k') }, dir)).toThrow(/outside the data directory/);
    expect(() => loadDataKey({ PARASHURAMA_DATA_KEY: randomBytes(16).toString('base64') }, dir)).toThrow(/32 bytes/);
  });
});
