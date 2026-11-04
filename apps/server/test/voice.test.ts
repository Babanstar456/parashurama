import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage, type ClientRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app';
import { createUser } from '../src/auth';

/** Push-to-talk voice net: chunks are relayed live to the other stations on the same net, never echoed, never stored. */
let dir: string, app: Awaited<ReturnType<typeof buildApp>>['app'], db: any, base = '', cookie = '';
const post = (net: string, payload: any) => app.inject({ method: 'POST', url: `/api/voice/${net}`, payload, headers: { cookie } });

/** Open a listening station; collects events until closed. */
function listen(net: string, station: string) {
  const got: { ev: string; data: any }[] = [];
  let req!: ClientRequest;
  const ready = new Promise<void>((resolve, reject) => {
    req = request(`${base}/api/voice/${net}/events?station=${encodeURIComponent(station)}`, { headers: { cookie, accept: 'text/event-stream' } }, (res: IncomingMessage) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c; let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data != null) { got.push({ ev, data: JSON.parse(data) }); if (ev === 'peers') resolve(); }
        }
      });
    });
    req.on('error', (e: any) => { if (e.code !== 'ECONNRESET') reject(e); });
    req.end();
  });
  return { got, ready, close: () => req.destroy() };
}
const settle = () => new Promise((r) => setTimeout(r, 60));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'para-voice-'));
  ({ app, db } = await buildApp({ dataDir: dir, dataKey: randomBytes(32) }));
  createUser(db, { username: 'admin', name: 'Admin', role: 'admin' });
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { name: 'admin' } });
  cookie = String(r.headers['set-cookie']).split(';')[0];
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
});
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

describe('voice net (push-to-talk)', () => {
  it('relays speech to the other stations on the net, not back to the speaker, and not to other nets', async () => {
    const a = listen('unit', 'Station A1'), b = listen('unit', 'Station B2'), c = listen('crew-ABC123', 'Gun');
    await Promise.all([a.ready, b.ready, c.ready]); await settle();
    expect(a.got.filter((e) => e.ev === 'peers').at(-1)!.data.n).toBe(2);
    const pcm = Buffer.from(new Int16Array([0, 1000, -1000, 0]).buffer).toString('base64');
    expect((await post('unit', { station: 'Station A1', seq: 0, on: true })).json().heard).toBe(1);
    const r = await post('unit', { station: 'Station A1', seq: 1, sr: 16000, pcm });
    expect(r.statusCode).toBe(200); expect(r.json().heard).toBe(1);
    await settle();
    expect(b.got.find((e) => e.ev === 'talk')!.data).toEqual({ from: 'Station A1', seq: 0, on: true });
    expect(b.got.find((e) => e.ev === 'audio')!.data).toEqual({ from: 'Station A1', seq: 1, sr: 16000, pcm });
    expect(a.got.some((e) => e.ev === 'audio')).toBe(false);
    expect(c.got.some((e) => e.ev === 'audio' || e.ev === 'talk')).toBe(false);
    a.close(); b.close(); c.close();
  });
  it('rejects bad nets, callsigns and oversized or malformed chunks; needs a session', async () => {
    expect((await post('../etc', { station: 'S', seq: 0 })).statusCode).toBe(404);
    expect((await post('lobby', { station: 'S', seq: 0 })).statusCode).toBe(400);
    expect((await post('unit', { station: '<script>', seq: 0 })).statusCode).toBe(400);
    expect((await post('unit', { station: 'S', seq: 1, sr: 16000, pcm: 'A'.repeat(70_000) })).statusCode).toBe(400);
    expect((await post('unit', { station: 'S', seq: 1, sr: 44100, pcm: 'AAAA' })).statusCode).toBe(400);
    expect((await post('unit', { station: 'S', seq: 1, sr: 16000, pcm: 'not base64!' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/voice/unit', payload: { station: 'S', seq: 0 } })).statusCode).toBe(401);
  });
});
