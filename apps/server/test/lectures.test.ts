// Lecture library: upload, list, stream with range requests, delete; roles, types and size limits enforced.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app';
import { createUser } from '../src/auth';

let dir: string, app: any, db: any;
const cookie: Record<string, string> = {};
const video = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251)); // stand-in bytes; the server never decodes video
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'para-lec-'));
  ({ app, db } = await buildApp({ dataDir: dir, lectureMaxBytes: 10_000 }));
  createUser(db, { username: 'inst', name: 'Instructor', role: 'instructor' });
  createUser(db, { username: 'sep', name: 'Sep Test', role: 'trainee' });
  for (const who of ['inst', 'sep']) cookie[who] = String((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { name: who } })).headers['set-cookie']).split(';')[0];
});
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
const upload = (who: string, body: Buffer, q = 'title=Reading%20the%20RF%20clue&topic=Sensors&description=Ten%20minutes&duration=612.5', type = 'video/mp4') =>
  app.inject({ method: 'POST', url: `/api/lectures?${q}`, headers: { cookie: cookie[who], 'content-type': type }, payload: body });

describe('lecture library', () => {
  let id = 0;
  it('lets an instructor upload a video and records its size and SHA-256', async () => {
    const r = await upload('inst', video);
    expect(r.statusCode).toBe(200);
    id = r.json().id;
    expect(r.json()).toMatchObject({ size: 5000, sha256: createHash('sha256').update(video).digest('hex') });
    const list = (await app.inject({ method: 'GET', url: '/api/lectures', headers: { cookie: cookie.sep } })).json();
    expect(list.topics).toContain('Sensors');
    expect(list.lectures[0]).toMatchObject({ id, title: 'Reading the RF clue', topic: 'Sensors', description: 'Ten minutes', mime: 'video/mp4', duration: 612.5, author: 'Instructor' });
  });

  it('streams the whole file, and byte ranges for seeking', async () => {
    const full = await app.inject({ method: 'GET', url: `/api/lectures/${id}/video`, headers: { cookie: cookie.sep } });
    expect(full.statusCode).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(Buffer.compare(full.rawPayload, video)).toBe(0);
    const part = await app.inject({ method: 'GET', url: `/api/lectures/${id}/video`, headers: { cookie: cookie.sep, range: 'bytes=100-199' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 100-199/5000');
    expect(Buffer.compare(part.rawPayload, video.subarray(100, 200))).toBe(0);
    const tail = await app.inject({ method: 'GET', url: `/api/lectures/${id}/video`, headers: { cookie: cookie.sep, range: 'bytes=-10' } });
    expect(Buffer.compare(tail.rawPayload, video.subarray(4990))).toBe(0);
    expect((await app.inject({ method: 'GET', url: `/api/lectures/${id}/video`, headers: { cookie: cookie.sep, range: 'bytes=9000-' } })).statusCode).toBe(416);
    expect((await app.inject({ method: 'GET', url: `/api/lectures/${id}/video` })).statusCode).toBe(401);
  });

  it('refuses trainees, other file types, missing titles, unknown topics and oversized files', async () => {
    expect((await upload('sep', video)).statusCode).toBe(403);
    expect((await upload('inst', video, undefined, 'video/x-msvideo')).statusCode).toBe(415);
    expect((await upload('inst', video, 'topic=Sensors')).statusCode).toBe(400);
    expect((await upload('inst', video, 'title=X&topic=Cooking')).statusCode).toBe(400);
    expect((await upload('inst', Buffer.alloc(0), 'title=X&topic=Sensors')).statusCode).toBe(400);
    expect((await upload('inst', Buffer.alloc(20_000, 1), 'title=Big&topic=Sensors')).statusCode).toBe(413);
    expect(readdirSync(join(dir, 'lectures')).filter((f) => f.endsWith('.part'))).toEqual([]); // no partial files left behind
  });

  it('lets an instructor delete a lecture, removing the file', async () => {
    const file = (db.prepare('SELECT file FROM lectures WHERE id=?').get(id) as any).file;
    expect((await app.inject({ method: 'DELETE', url: `/api/lectures/${id}`, headers: { cookie: cookie.sep } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/lectures/${id}`, headers: { cookie: cookie.inst } })).statusCode).toBe(200);
    expect(existsSync(join(dir, 'lectures', file))).toBe(false);
    expect((await app.inject({ method: 'GET', url: `/api/lectures/${id}/video`, headers: { cookie: cookie.sep } })).statusCode).toBe(404);
    const ev = (db.prepare("SELECT action FROM audit WHERE action LIKE 'lecture-%'").all() as any[]).map((e) => e.action);
    expect(ev).toEqual(['lecture-upload', 'lecture-delete']);
  });
});
