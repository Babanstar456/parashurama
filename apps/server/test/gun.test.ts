import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlRoomAI, createGun, defaultGunCfg, driveGun, gunCrewAI, runGun, scoreControl, scoreField, scoreGround, stepGun, type GunAction, type GunEngine } from '@parashurama/engine';
import { buildApp } from '../src/app';
import { createUser } from '../src/auth';

let dir: string, app: Awaited<ReturnType<typeof buildApp>>['app'], db: any, base = '';
const cookies: Record<string, string> = {};
const call = (method: string, url: string, who?: string, payload?: any) => app.inject({ method: method as any, url, payload, headers: who ? { cookie: cookies[who] } : {} });
async function login(who: string) { const r = await call('POST', '/api/auth/login', undefined, { name: who }); cookies[who] = String(r.headers['set-cookie']).split(';')[0]; }
/** Read a Server-Sent Events stream until `stop` returns true. */
function sse(url: string, who: string, stop: (ev: string, data: any) => boolean, timeoutMs = 20000): Promise<{ ev: string; data: any }[]> {
  return new Promise((resolve, reject) => {
    const got: { ev: string; data: any }[] = [];
    const req = request(base + url, { headers: { cookie: cookies[who], accept: 'text/event-stream' } }, (res: IncomingMessage) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (!ev || data == null) continue;
          const d = JSON.parse(data); got.push({ ev, data: d });
          if (stop(ev, d)) { req.destroy(); resolve(got); return; }
        }
      });
    });
    req.on('error', (e: any) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.end();
    setTimeout(() => { req.destroy(); reject(new Error(`SSE timeout; got ${got.map((g) => g.ev).join(',')}`)); }, timeoutMs);
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'para-gun-'));
  ({ app, db } = await buildApp({ dataDir: dir, dataKey: randomBytes(32), crewTickMs: 2 }));
  createUser(db, { username: 'admin', name: 'Admin', role: 'admin' });
  createUser(db, { username: 'gnr-01', name: 'Gunner 01', role: 'trainee' });
  createUser(db, { username: 'fco-01', name: 'Fire Control 01', role: 'trainee' });
  await login('admin'); await login('gnr-01'); await login('fco-01');
  await app.listen({ port: 0, host: '127.0.0.1' });
  const a = app.server.address() as any; base = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

describe('gun drills on the unit server', () => {
  it('re-runs a solo On Ground drill, stores it sealed, and returns it in the history', async () => {
    const cfg = defaultGunCfg({ seed: 777, difficulty: 2 }), E = createGun(cfg);
    const log = driveGun(E, [controlRoomAI, (x) => gunCrewAI(x)]), total = scoreGround(E).total;
    const r = await call('POST', '/api/gun/drills', 'gnr-01', { game: 'ground', cfg, actions: log, endTick: E.tick, clientTotal: total });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ total, verified: true, flags: [] });
    const row = db.prepare('SELECT actions, record FROM gun_drills WHERE id=?').get(r.json().id);
    expect(row.actions.startsWith('v1:')).toBe(true); expect(row.record.startsWith('v1:')).toBe(true);
    const mine = (await call('GET', '/api/gun/drills/mine', 'gnr-01')).json().drills;
    expect(mine.at(-1)).toMatchObject({ game: 'ground', total, n: 1 });
  });
  it('re-runs a solo 3D field drill (L70, swarm, night) and stores it as game field', async () => {
    const cfg = defaultGunCfg({ seed: 779, gun: 'l70', difficulty: 4, selfId: true, swarm: true, time: 'night', weather: 'fog' }), E = createGun(cfg);
    const log = driveGun(E, [controlRoomAI, (x) => gunCrewAI(x)]), total = scoreField(E).total;
    expect(log.some((a) => a.k === 'ident')).toBe(true);
    const r = await call('POST', '/api/gun/drills', 'gnr-01', { game: 'field', cfg, actions: log, endTick: E.tick, clientTotal: total });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ total, verified: true, flags: [] });
    const mine = (await call('GET', '/api/gun/drills/mine', 'gnr-01')).json().drills;
    expect(mine.at(-1)).toMatchObject({ game: 'field', total, cfg: { selfId: true, swarm: true, gun: 'l70' } });
  });
  it('ignores forged orders from the "AI" seat: the server replays the control room itself', async () => {
    const cfg = defaultGunCfg({ seed: 778, difficulty: 2 }), E = createGun(cfg);
    // A cheat: invent an early RANGE CLEAR + FIRE on target 1, then fire as soon as it appears.
    const cheat = (x: GunEngine): GunAction[] => (x.tick === 1 ? [{ tick: 1, seat: 'cr', k: 'order', o: 'rangeClear' }] : x.targets[0] && x.cleared == null && x.tick < 400 ? [{ tick: x.tick, seat: 'cr', k: 'order', o: 'engage', cid: 1 }] : []);
    const log = driveGun(E, [cheat, controlRoomAI, (x) => gunCrewAI(x)]);
    const claimed = scoreGround(E).total;
    const r = (await call('POST', '/api/gun/drills', 'gnr-01', { game: 'ground', cfg, actions: log, endTick: E.tick, clientTotal: claimed })).json();
    const honest = scoreGround(runGun(cfg, { actions: log.filter((a) => a.seat === 'gun'), policies: [controlRoomAI], until: E.tick })).total;
    expect(r.total).toBe(honest);
    if (honest !== claimed) expect(r.flags).toContain('client-score-mismatch');
  });
  it('rejects bad gun drill payloads with 400', async () => {
    expect((await call('POST', '/api/gun/drills', 'gnr-01', { game: 'ground', cfg: { ...defaultGunCfg(), gun: 'bofors' }, actions: [], endTick: 5 })).statusCode).toBe(400);
    expect((await call('POST', '/api/gun/drills', 'gnr-01', { game: 'ground', cfg: defaultGunCfg(), actions: [{ tick: 3, seat: 'gun', k: 'launch' }], endTick: 5 })).statusCode).toBe(400);
  });
});

describe('crew drill over the LAN (Server-Sent Events)', () => {
  it('two trainees share one drill: seats, live ticks, server-stamped seat, scores stored for each', async () => {
    const room = (await call('POST', '/api/crews', 'fco-01', { cfg: defaultGunCfg({ seed: 31337, difficulty: 2 }) })).json();
    expect(room.code).toMatch(/^[A-Z2-9]{5}$/);
    expect((await call('POST', `/api/crews/${room.code}/seat`, 'fco-01', { seat: 'cr' })).statusCode).toBe(200);
    expect((await call('POST', `/api/crews/${room.code}/seat`, 'gnr-01', { seat: 'cr' })).statusCode).toBe(409); // taken
    expect((await call('POST', `/api/crews/${room.code}/seat`, 'gnr-01', { seat: 'gun' })).statusCode).toBe(200);
    // The gunner's client: mirror the drill from the stream and play its seat with the expert crew; the officer plays the control room.
    const mirror = createGun(room.cfg);
    let sent = 0;
    const play = async (seat: 'cr' | 'gun', who: string, E: GunEngine) => {
      const acts = (seat === 'cr' ? controlRoomAI(E) : gunCrewAI(E)).map(({ tick: _t, seat: _s, ...a }) => ({ ...a, seat: seat === 'cr' ? 'gun' : 'cr' }));
      if (acts.length) { sent++; await call('POST', `/api/crews/${room.code}/act`, who, { acts }); }
    };
    const officer = createGun(room.cfg);
    const feed = sse(`/api/crews/${room.code}/events`, 'gnr-01', (ev, d) => {
      if (ev === 'tick') { stepGun(mirror, d.a); stepGun(officer, d.a); void play('gun', 'gnr-01', mirror); void play('cr', 'fco-01', officer); }
      return ev === 'end';
    }, 60000);
    await new Promise((r) => setTimeout(r, 50));
    expect((await call('POST', `/api/crews/${room.code}/start`, 'gnr-01')).statusCode).toBe(200);
    const events = await feed;
    const end = events.find((e) => e.ev === 'end')!.data;
    const ticks = events.filter((e) => e.ev === 'tick');
    expect(ticks.length).toBeGreaterThan(50);
    // Every action carries the seat the server gave its sender (the client's claimed seat was overwritten).
    const all = ticks.flatMap((t) => t.data.a) as GunAction[];
    expect(all.some((a) => a.seat === 'gun' && a.k === 'check')).toBe(true);
    expect(all.some((a) => a.seat === 'cr' && a.k === 'order')).toBe(true);
    // The mirror, built only from the stream, matches the server's scores.
    expect(scoreGround(mirror).total).toBe(end.scores.gun);
    expect(scoreControl(mirror).total).toBe(end.scores.cr);
    expect(sent).toBeGreaterThan(0);
    const g = (await call('GET', '/api/gun/drills/mine', 'gnr-01')).json().drills.at(-1), c = (await call('GET', '/api/gun/drills/mine', 'fco-01')).json().drills.at(-1);
    expect(g).toMatchObject({ game: 'ground', crew: room.code, total: end.scores.gun });
    expect(c).toMatchObject({ game: 'control', crew: room.code, total: end.scores.cr });
    const board = (await call('GET', '/api/gun/readiness', 'admin')).json().operators.find((o: any) => o.name === 'Gunner 01');
    expect(board.drills).toBeGreaterThanOrEqual(2);
    console.log(`EVIDENCE crew drill over the LAN: 2 trainees, ${ticks.length} ticks streamed, scores control ${end.scores.cr} / gun ${end.scores.gun}, both stored and matching each client's own replay`);
  });
  it('an empty seat is played by the AI, and a late joiner gets the full log to rebuild the drill', async () => {
    const room = (await call('POST', '/api/crews', 'admin', { cfg: defaultGunCfg({ seed: 999, difficulty: 1 }) })).json();
    await call('POST', `/api/crews/${room.code}/start`, 'admin');
    await new Promise((r) => setTimeout(r, 150));
    const got = await sse(`/api/crews/${room.code}/events`, 'admin', (ev) => ev === 'sync', 5000);
    const sync = got.find((e) => e.ev === 'sync')!.data;
    const E = runGun(room.cfg, { actions: sync.log, until: sync.tick });
    expect(E.tick).toBe(sync.tick);
    expect(sync.log.some((a: GunAction) => a.seat === 'cr') && sync.log.some((a: GunAction) => a.seat === 'gun')).toBe(true);
    await call('POST', `/api/crews/${room.code}/end`, 'admin');
  });
});
