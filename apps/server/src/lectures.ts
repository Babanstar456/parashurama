// Lecture library: instructors upload training videos once; every trainee on the unit network can watch them.
// Files are stored in <dataDir>/lectures/ and streamed with HTTP range requests (seeking works on any player).
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit, type DB } from './db';
import { BadRequest } from './verify';

/** Formats every browser can play without plugins. */
export const LECTURE_TYPES: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv' };
export const TOPICS = ['Basics', 'Threat recognition', 'Sensors', 'Effectors', 'Doctrine and ROE', 'Exercises', 'Other'];

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
const text = (v: unknown, name: string, max: number, required = true) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new BadRequest(`${name} is required`);
  if (s.length > max) throw new BadRequest(`${name} must be at most ${max} characters`);
  return s;
};

export function registerLectures(app: FastifyInstance, db: DB, dataDir: string, need: (...roles: string[]) => Guard, maxBytes: number) {
  const dir = join(dataDir, 'lectures'); mkdirSync(dir, { recursive: true });
  // Video bodies arrive as a raw stream (no multipart dependency); the size limit is enforced while streaming.
  app.addContentTypeParser(Object.keys(LECTURE_TYPES), (_req, payload, done) => done(null, payload));
  const row = (id: number) => db.prepare('SELECT * FROM lectures WHERE id=?').get(id) as any;
  const pub = (r: any) => ({ id: r.id, title: r.title, topic: r.topic, description: r.description, mime: r.mime, size: r.size, duration: r.duration, sha256: r.sha256, created: r.created_at, author: r.author_name ?? null });

  app.get('/api/lectures', { preHandler: need() }, async () => ({
    topics: TOPICS, maxBytes,
    lectures: (db.prepare('SELECT l.*, u.name AS author_name FROM lectures l LEFT JOIN users u ON u.id=l.author ORDER BY l.topic, l.created_at').all() as any[]).map(pub) }));

  // POST /api/lectures?title=…&topic=…&description=…&duration=…   body: the video file (Content-Type video/mp4|webm|ogg)
  app.post('/api/lectures', { preHandler: need('instructor', 'admin') }, async (req, reply) => {
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim();
    if (!LECTURE_TYPES[mime]) return reply.code(415).send({ error: 'Upload an MP4, WebM or Ogg video' });
    const q = req.query as Record<string, string>;
    const title = text(q.title, 'title', 120), topic = text(q.topic, 'topic', 40), description = text(q.description, 'description', 1000, false);
    if (!TOPICS.includes(topic)) throw new BadRequest(`topic must be one of: ${TOPICS.join(', ')}`);
    const duration = q.duration != null && q.duration !== '' && Number.isFinite(+q.duration) && +q.duration >= 0 ? +q.duration : null;
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBytes) return reply.code(413).send({ error: `Video is larger than the ${Math.round(maxBytes / 1048576)} MB limit` });
    const file = `${Date.now()}-${randomBytes(6).toString('hex')}.${LECTURE_TYPES[mime]}`, tmp = join(dir, file + '.part');
    const hash = createHash('sha256'); let size = 0;
    const meter = new Transform({ transform(chunk, _e, cb) { size += chunk.length; if (size > maxBytes) return cb(Object.assign(new Error('too large'), { tooLarge: true })); hash.update(chunk); cb(null, chunk); } });
    try { await pipeline(req.body as NodeJS.ReadableStream, meter, createWriteStream(tmp)); }
    catch (e: any) { rmSync(tmp, { force: true }); if (e.tooLarge) return reply.code(413).send({ error: `Video is larger than the ${Math.round(maxBytes / 1048576)} MB limit` }); throw e; }
    if (!size) { rmSync(tmp, { force: true }); throw new BadRequest('The video file is empty'); }
    renameSync(tmp, join(dir, file));
    const sha256 = hash.digest('hex');
    const id = Number(db.prepare('INSERT INTO lectures(title,topic,description,file,mime,size,duration,sha256,author,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(title, topic, description, file, mime, size, duration, sha256, req.user!.id, Date.now()).lastInsertRowid);
    audit(db, req.user!.id, 'lecture-upload', `#${id} ${title} (${Math.round(size / 1024)} KB, sha256 ${sha256.slice(0, 12)})`);
    return { id, size, sha256 };
  });

  // Streams the file; honours Range so players can seek without downloading everything.
  app.get('/api/lectures/:id/video', { preHandler: need() }, async (req: any, reply) => {
    const r = row(+req.params.id), path = r && join(dir, r.file);
    if (!r || !existsSync(path)) return reply.code(404).send({ error: 'No such lecture' });
    const total = statSync(path).size, range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    reply.header('Accept-Ranges', 'bytes').header('Content-Type', r.mime).header('Cache-Control', 'private, max-age=3600');
    if (!range || (range[1] === '' && range[2] === '')) return reply.header('Content-Length', total).send(createReadStream(path));
    let start = range[1] === '' ? total - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1);
    if (start < 0) start = 0;
    if (start >= total || start > end) return reply.code(416).header('Content-Range', `bytes */${total}`).send();
    return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${total}`).header('Content-Length', end - start + 1).send(createReadStream(path, { start, end }));
  });

  app.delete('/api/lectures/:id', { preHandler: need('instructor', 'admin') }, async (req: any, reply) => {
    const r = row(+req.params.id);
    if (!r) return reply.code(404).send({ error: 'No such lecture' });
    rmSync(join(dir, r.file), { force: true });
    db.prepare('DELETE FROM lectures WHERE id=?').run(r.id);
    audit(db, req.user!.id, 'lecture-delete', `#${r.id} ${r.title}`);
    return { ok: true };
  });
}
