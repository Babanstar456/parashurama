// Evidence: records survive a server restart, and drill history exports as CSV scoped by role.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createEngine, defaultConfig, expertPolicy, isDone, packPayload, runTotal, scoreRun, step, ticks, type Action, type DrillConfig } from '@parashurama/engine';
import { buildApp } from '../src/app';
import { createUser } from '../src/auth';

const dir = mkdtempSync(join(tmpdir(), 'para-ev-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cfg = (seed: number): DrillConfig => ({ seed, drill: 1, time: 'day', terrain: 'rural', fault: 'none', faultSector: 0, pattern: 'mixed', difficulty: 3, focus: { sector: null, loiter: false, decoy: false } });
function expertDrill(c: DrillConfig) {
  const E = createEngine(c); const actions: Action[] = [];
  while (E.tick < ticks(defaultConfig, 150)) { const a = expertPolicy(E); actions.push(...a); step(E, a); if (isDone(E)) break; }
  return { cfg: c, actions, endTick: E.tick, mode: 'scored', clientTotal: runTotal(scoreRun(E)) };
}
async function signIn(app: any, name: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { name } });
  expect(r.statusCode).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0];
}

describe('evidence: persistence and export', () => {
  it('keeps every verified session across a server restart', async () => {
    let { app, db } = await buildApp({ dataDir: dir });
    createUser(db, { username: 'inst', name: 'Instructor', role: 'instructor' });
    createUser(db, { username: 'sep.a', name: 'Sep Demo A', role: 'trainee' });
    createUser(db, { username: 'sep.b', name: 'Sep Demo B', role: 'trainee' });
    const a = await signIn(app, 'sep.a');
    for (const s of [11, 12, 13]) expect((await app.inject({ method: 'POST', url: '/api/drills', headers: { cookie: a }, payload: expertDrill(cfg(s)) })).json().verified).toBe(true);
    const b = await signIn(app, 'sep.b');
    expect((await app.inject({ method: 'POST', url: '/api/drills', headers: { cookie: b }, payload: expertDrill(cfg(14)) })).statusCode).toBe(200);
    await app.close(); db.close();

    ({ app, db } = await buildApp({ dataDir: dir }));
    const mine = (await app.inject({ method: 'GET', url: '/api/drills/mine', headers: { cookie: await signIn(app, 'sep.a') } })).json().drills;
    console.log(`EVIDENCE sessions surviving a server restart: ${mine.length}`);
    expect(mine).toHaveLength(3);
    expect(mine[0].cls).toMatchObject({ falsePositives: 0 });
    await app.close(); db.close();
  });

  it('exports CSV: trainees get only their own drills, instructors the whole unit', async () => {
    const { app, db } = await buildApp({ dataDir: dir });
    const csv = async (who: string) => app.inject({ method: 'GET', url: '/api/export/drills.csv', headers: { cookie: await signIn(app, who) } });
    const own = await csv('sep.a');
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toMatch(/text\/csv/);
    expect(own.headers['content-disposition']).toMatch(/attachment/);
    const ownRows = own.body.trim().split('\r\n').slice(1);
    expect(ownRows).toHaveLength(3);
    expect(ownRows.every((r) => r.startsWith('Sep Demo A,'))).toBe(true);
    expect(ownRows[0]).toContain(',yes,'); // verified by the server
    const unit = (await csv('inst')).body.trim().split('\r\n').slice(1);
    expect(unit).toHaveLength(4);
    expect((await app.inject({ method: 'GET', url: '/api/export/drills.csv' })).statusCode).toBe(401);
    const events = db.prepare("SELECT detail FROM audit WHERE action='export-csv'").all() as any[];
    expect(events.length).toBe(2);
    await app.close(); db.close();
  });

  it('records a study cohort per user and exports it in the CSV', async () => {
    const { app, db } = await buildApp({ dataDir: dir });
    const inst = await signIn(app, 'inst');
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: await signIn(app, 'sep.b') } })).json().user;
    expect(me.cohort).toBe('adaptive');
    expect((await app.inject({ method: 'PUT', url: `/api/users/${me.id}/cohort`, headers: { cookie: inst }, payload: { cohort: 'control' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: `/api/users/${me.id}/cohort`, headers: { cookie: inst }, payload: { cohort: 'placebo' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `/api/users/${me.id}/cohort`, headers: { cookie: await signIn(app, 'sep.a') }, payload: { cohort: 'control' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: await signIn(app, 'sep.b') } })).json().user.cohort).toBe('control');
    const csv = (await app.inject({ method: 'GET', url: '/api/export/drills.csv', headers: { cookie: inst } })).body.trim().split('\r\n');
    expect(csv[0].endsWith(',cohort')).toBe(true);
    expect(csv.find((r) => r.startsWith('Sep Demo B,'))!.endsWith(',control')).toBe(true);
    await app.close(); db.close();
  });

  it('installs a signed threat pack as a new config version; refuses tampered, invalid or unauthorised packs', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
    const { app, db } = await buildApp({ dataDir: dir, trustKeys: [{ id: 'dssc-test', issuer: 'DSSC', jwk: { kty, crv, x, y } }] });
    const mk = (threats: any) => { const meta = { id: 'pack-t', version: '1.0.1', issuer: 'DSSC', date: '2026-11-01' }, config = { threats };
      return { meta, config, sig: sign('sha256', packPayload({ meta, config }), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') }; };
    const t = JSON.parse(JSON.stringify(defaultConfig.threats)); t.threats.recon.speed = 13;
    const inst = await signIn(app, 'inst');
    const post = (cookie: string, payload: any) => app.inject({ method: 'POST', url: '/api/packs', headers: { cookie }, payload });
    const ok = await post(inst, mk(t));
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/config', headers: { cookie: inst } })).json().config.threats.threats.recon.speed).toBe(13);
    const tampered = mk(t); tampered.config.threats.threats.recon.speed = 14;
    expect((await post(inst, tampered)).json().error).toMatch(/Signature does not match/);
    const bad = JSON.parse(JSON.stringify(t)); bad.threats.recon.alt = [150, 60];
    const inv = await post(inst, mk(bad));
    expect(inv.statusCode).toBe(400); expect(inv.json().errors.join()).toMatch(/alt min > max/);
    expect((await post(await signIn(app, 'sep.a'), mk(t))).statusCode).toBe(403);
    const ev = (db.prepare("SELECT action FROM audit WHERE action LIKE 'pack-%'").all() as any[]).map((e) => e.action);
    expect(ev).toEqual(['pack-installed', 'pack-rejected', 'pack-rejected']);
    await app.close(); db.close();
  });
});
