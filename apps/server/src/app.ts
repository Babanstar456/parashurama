import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultConfig, drillsToCsv, mastery, validateConfig, type Config } from '@parashurama/engine';
import { audit, openDb, type DB } from './db';
import { createSession, createUser, dropSession, Limiter, userForToken, usernameFor, type Cohort, type Role, type User } from './auth';
import { BadRequest, cleanCfg, cleanSpawns, verifyDrill } from './verify';

export interface Options { dataDir: string; webDir?: string; secureCookies?: boolean; logger?: boolean; }
declare module 'fastify' { interface FastifyRequest { user: User | null } }
const COOKIE = 'psid';
const ROLES: Role[] = ['trainee', 'instructor', 'commander', 'admin'];
const COHORTS: Cohort[] = ['adaptive', 'control'];
const VERSION = '0.6.0';

export async function buildApp(o: Options) {
  const db: DB = openDb(o.dataDir);
  const app = Fastify({ logger: o.logger ?? false, bodyLimit: 2 * 1024 * 1024, trustProxy: false });
  await app.register(cookie);
  // Accept an empty JSON body as {} (e.g. logout/backup calls); reject malformed JSON with 400.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const txt = String(body ?? '');
    if (!txt.trim()) return done(null, {});
    try { done(null, JSON.parse(txt)); } catch { const e: any = new Error('Malformed JSON body'); e.statusCode = 400; done(e, undefined); }
  });
  const loginIp = new Limiter(30, 60_000);
  let cache: { id: number | null; config: Config } | null = null;
  const activeConfig = () => {
    if (cache) return cache;
    const r = db.prepare('SELECT id, config FROM config_versions ORDER BY id DESC LIMIT 1').get() as any;
    cache = r ? { id: r.id, config: JSON.parse(r.config) } : { id: null, config: defaultConfig };
    return cache;
  };

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    req.user = userForToken(db, req.cookies[COOKIE]);
    // CSRF defence for a LAN app: state-changing calls must be same-origin JSON (cookies are also SameSite=Strict).
    if (req.url.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) {
      const origin = req.headers.origin, host = req.headers.host;
      if (origin && host && new URL(origin).host !== host) return reply.code(403).send({ error: 'Cross-origin request refused' });
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (o.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof BadRequest || err.status === 400 || err.validation) return reply.code(400).send({ error: err.message });
    if (err.statusCode >= 400 && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err); return reply.code(500).send({ error: 'Server error' });
  });
  const need = (...roles: Role[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: 'Sign in first' });
    if (roles.length && !roles.includes(req.user.role)) return reply.code(403).send({ error: 'Your role cannot do this' });
  };
  const str = (v: any, name: string, max = 80) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new BadRequest(`${name} is required (max ${max} characters)`); return v.trim(); };

  app.get('/api/health', async () => ({ ok: true, version: VERSION, mode: 'server' }));

  // Sign-in is by name only (no passwords): an existing account is matched by name or username, otherwise a new trainee is created.
  app.post('/api/auth/login', async (req, reply) => {
    if (!loginIp.hit(req.ip)) return reply.code(429).send({ error: 'Too many attempts' });
    const name = str((req.body as any)?.name, 'name').replace(/\s+/g, ' ');
    const username = usernameFor(name);
    if (username.length < 2) throw new BadRequest('name must contain at least 2 letters or digits');
    const find = () => db.prepare('SELECT * FROM users WHERE (username=? OR name=? COLLATE NOCASE) AND disabled=0 ORDER BY id LIMIT 1').get(username, name) as any;
    let u = find();
    if (!u) {
      if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return reply.code(403).send({ error: 'This account is disabled' });
      const id = createUser(db, { username, name, role: 'trainee', unit: (db.prepare("SELECT unit FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any)?.unit });
      audit(db, id, 'user-create', `${username} (trainee, self sign-in)`); u = find();
    }
    reply.setCookie(COOKIE, createSession(db, u.id), { httpOnly: true, sameSite: 'strict', secure: !!o.secureCookies, path: '/', maxAge: 12 * 3600 });
    audit(db, u.id, 'login');
    return { user: { id: u.id, username: u.username, name: u.name, role: u.role, unit: u.unit, settings: JSON.parse(u.settings), cohort: u.cohort } };
  });
  app.post('/api/auth/logout', async (req, reply) => { dropSession(db, req.cookies[COOKIE]); reply.clearCookie(COOKIE, { path: '/' }); return { ok: true }; });
  app.get('/api/me', { preHandler: need() }, async (req) => ({ user: req.user }));
  app.put('/api/me/settings', { preHandler: need() }, async (req) => {
    const s = JSON.stringify(req.body ?? {}); if (s.length > 20_000) throw new BadRequest('settings too large');
    db.prepare('UPDATE users SET settings=? WHERE id=?').run(s, req.user!.id); return { ok: true };
  });

  app.get('/api/config', { preHandler: need() }, async () => { const a = activeConfig(); return { config: a.config, version: a.id, custom: a.id != null }; });
  app.put('/api/config', { preHandler: need('instructor', 'admin') }, async (req, reply) => {
    const b: any = req.body ?? {}; const r = validateConfig(b.config);
    if (!r.ok) return reply.code(400).send({ error: 'Invalid config', errors: r.errors });
    const id = Number(db.prepare('INSERT INTO config_versions(config,author,note,created_at) VALUES(?,?,?,?)').run(JSON.stringify(b.config), req.user!.id, String(b.note ?? '').slice(0, 200), Date.now()).lastInsertRowid);
    cache = null; audit(db, req.user!.id, 'config-update', `v${id} ${b.note ?? ''}`); return { version: id };
  });
  app.get('/api/config/history', { preHandler: need('instructor', 'admin') }, async () => ({
    versions: db.prepare('SELECT c.id, c.note, c.created_at AS at, u.name AS author FROM config_versions c LEFT JOIN users u ON u.id=c.author ORDER BY c.id DESC LIMIT 50').all() }));

  app.post('/api/drills', { preHandler: need() }, async (req) => {
    const a = activeConfig();
    const v = await verifyDrill(a.config, req.body ?? {});
    const n = (db.prepare('SELECT COUNT(*) AS n FROM drills WHERE user_id=?').get(req.user!.id) as any).n + 1;
    const record = { ...v.record, n };
    const id = Number(db.prepare(`INSERT INTO drills(user_id,created_at,mode,template,cfg,spawns,actions,end_tick,total,client_total,verified,chain,flags,record,config_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.user!.id, Date.now(), v.mode, record.template, JSON.stringify(v.cfg), v.spawns ? JSON.stringify(v.spawns) : null, JSON.stringify(v.actions),
      v.endTick, v.total, (req.body as any)?.clientTotal ?? null, v.verified ? 1 : 0, v.chain, JSON.stringify(v.flags), JSON.stringify(record), a.id).lastInsertRowid);
    if (v.flags.length) audit(db, req.user!.id, 'drill-flagged', `#${id} ${v.flags.join(',')}`);
    return { id, total: v.total, verified: v.verified, flags: v.flags, chain: v.chain };
  });
  const history = (userId: number) => (db.prepare('SELECT record FROM drills WHERE user_id=? ORDER BY created_at, id').all(userId) as any[]).map((r) => JSON.parse(r.record));
  app.get('/api/drills/mine', { preHandler: need() }, async (req) => ({ drills: history(req.user!.id) }));

  app.get('/api/readiness', { preHandler: need() }, async (req) => {
    const C = activeConfig().config;
    const rows = (req.user!.role === 'trainee'
      ? db.prepare("SELECT id,name,unit,role FROM users WHERE id=?").all(req.user!.id)
      : db.prepare("SELECT id,name,unit,role FROM users WHERE disabled=0 AND (role IN ('trainee','instructor') OR id=?) ORDER BY name").all(req.user!.id)) as any[];
    return { operators: rows.map((u) => { const H = history(u.id); return { ...u, mastery: mastery(H, C), drills: H.length, lastTotal: H.length ? H[H.length - 1].total : null }; }) };
  });

  // Drill history as CSV for after-action review: trainees get their own drills, other roles the whole unit.
  app.get('/api/export/drills.csv', { preHandler: need() }, async (req, reply) => {
    const own = req.user!.role === 'trainee';
    const rows = db.prepare(`SELECT d.record, d.verified, u.name, u.unit, u.cohort FROM drills d JOIN users u ON u.id=d.user_id ${own ? 'WHERE d.user_id=?' : ''} ORDER BY d.created_at, d.id`)
      .all(...(own ? [req.user!.id] : [])) as any[];
    audit(db, req.user!.id, 'export-csv', `${rows.length} drills${own ? ' (own)' : ''}`);
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="parashurama-drills.csv"')
      .send(drillsToCsv(rows.map((r) => ({ operator: r.name, unit: r.unit, verified: !!r.verified, cohort: r.cohort, record: JSON.parse(r.record) })), activeConfig().config.training.certification.passMark));
  });

  app.get('/api/templates', { preHandler: need() }, async () => ({ templates: (db.prepare('SELECT id,name,cfg,spawns FROM templates ORDER BY id').all() as any[]).map((t) => ({ id: t.id, name: t.name, cfg: JSON.parse(t.cfg), spawns: JSON.parse(t.spawns) })) }));
  app.post('/api/templates', { preHandler: need('instructor', 'admin') }, async (req) => {
    const b: any = req.body ?? {}; const C = activeConfig().config;
    const name = str(b.name, 'name');
    const cfg = cleanCfg({ seed: 1, drill: 1, faultSector: 0, difficulty: 3, ...b.cfg });
    const spawns = cleanSpawns(b.spawns, C);
    const id = Number(db.prepare('INSERT INTO templates(name,cfg,spawns,author,created_at) VALUES(?,?,?,?,?)').run(name, JSON.stringify({ time: cfg.time, terrain: cfg.terrain, fault: cfg.fault, pattern: cfg.pattern, weather: cfg.weather ?? 'clear' }), JSON.stringify(spawns), req.user!.id, Date.now()).lastInsertRowid);
    audit(db, req.user!.id, 'template-create', name); return { id };
  });
  app.delete('/api/templates/:id', { preHandler: need('instructor', 'admin') }, async (req: any) => { db.prepare('DELETE FROM templates WHERE id=?').run(+req.params.id); audit(db, req.user!.id, 'template-delete', String(req.params.id)); return { ok: true }; });

  app.get('/api/users', { preHandler: need('admin') }, async () => ({ users: db.prepare('SELECT id,username,name,role,unit,disabled,cohort FROM users ORDER BY id').all() }));
  app.post('/api/users', { preHandler: need('admin') }, async (req, reply) => {
    const b: any = req.body ?? {};
    const username = str(b.username, 'username', 40).toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new BadRequest('username: 3–40 letters, digits, dot, dash or underscore');
    if (!ROLES.includes(b.role)) throw new BadRequest(`role must be one of: ${ROLES.join(', ')}`);
    if (b.cohort != null && !COHORTS.includes(b.cohort)) throw new BadRequest(`cohort must be one of: ${COHORTS.join(', ')}`);
    try { const id = createUser(db, { username, name: str(b.name, 'name'), role: b.role, unit: b.unit ? str(b.unit, 'unit') : req.user!.unit, cohort: b.cohort }); audit(db, req.user!.id, 'user-create', `${username} (${b.role})`); return { id }; }
    catch (e: any) { if (String(e.message).includes('UNIQUE')) return reply.code(409).send({ error: 'That username already exists' }); throw e; }
  });
  // Study design: put a user in the adaptive group or the fixed-difficulty control group.
  app.put('/api/users/:id/cohort', { preHandler: need('admin', 'instructor') }, async (req: any, reply) => {
    const c = (req.body as any)?.cohort;
    if (!COHORTS.includes(c)) throw new BadRequest(`cohort must be one of: ${COHORTS.join(', ')}`);
    const r = db.prepare('UPDATE users SET cohort=? WHERE id=?').run(c, +req.params.id);
    if (!r.changes) return reply.code(404).send({ error: 'No such user' });
    audit(db, req.user!.id, 'cohort-set', `#${req.params.id} ${c}`); return { ok: true };
  });
  app.post('/api/admin/backup', { preHandler: need('admin') }, async (req) => { const file = backup(db, o.dataDir); audit(db, req.user!.id, 'backup', file); return { file }; });
  app.get('/api/admin/audit', { preHandler: need('admin') }, async () => ({ events: db.prepare('SELECT a.at,a.action,a.detail,u.username FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200').all() }));

  if (o.webDir && existsSync(join(o.webDir, 'index.html'))) {
    await app.register(fstatic, { root: resolve(o.webDir), index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => (req.method === 'GET' && !req.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: 'Not found' })));
  }
  return { app, db };
}

/** Consistent online backup (SQLite VACUUM INTO). Keeps the newest 14. */
export function backup(db: DB, dataDir: string): string {
  const dir = join(dataDir, 'backups'); mkdirSync(dir, { recursive: true });
  const file = join(dir, `parashurama-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 14))) rmSync(join(dir, f));
  return file;
}
