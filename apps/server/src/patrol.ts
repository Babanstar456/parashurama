/**
 * Urban patrol drills on the unit server: each drill the browser sends is re-run here from its seed and action log on the
 * same town (city.json `world`), scored again, and stored sealed like the gun drills. A client cannot send a score it did
 * not earn: the stored total is the server's. Readiness: drills, last and recent average per operator.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createPatrol, scorePatrol, stepPatrol, patrolMaxTicks, type Config, type PatrolAction, type PatrolCfg, type PatrolWorld } from '@parashurama/engine';
import type { DB } from './db';
import { open as unseal, seal } from './crypto';
import { BadRequest } from './verify';

const int = (v: any, lo: number, hi: number, n: string) => { if (!Number.isInteger(v) || v < lo || v > hi) throw new BadRequest(`${n} must be an integer between ${lo} and ${hi}`); return v; };
const num = (v: any, lo: number, hi: number, n: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new BadRequest(`${n} must be a number between ${lo} and ${hi}`); return v; };
const oneOf = <T extends string>(v: any, list: readonly T[], n: string): T => { if (!list.includes(v)) throw new BadRequest(`${n} must be one of: ${list.join(', ')}`); return v; };
const KINDS = ['drive', 'slew', 'trig', 'lock', 'spot', 'ident', 'load'] as const;

export interface PatrolRecordS { n: number; date: number; cfg: PatrolCfg; total: number; rules: string[]; metrics: Record<string, unknown>; endTick: number; verified: boolean; }

/** The town the patrol engine drives in: from the built web app, or the source tree (tests, development). */
export function loadPatrolWorld(webDir?: string): PatrolWorld | null {
  const tries = [webDir && resolve(webDir, 'city/city.json'), resolve(process.cwd(), 'apps/web/public/city/city.json'), resolve(process.cwd(), '../web/public/city/city.json')].filter(Boolean) as string[];
  for (const f of tries) if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')).world ?? null; } catch { /* try the next */ } }
  return null;
}

export function cleanPatrolCfg(c: any): PatrolCfg {
  if (!c || typeof c !== 'object') throw new BadRequest('cfg is required');
  const m = c.met ?? {};
  const cfg: PatrolCfg = {
    seed: int(c.seed, 0, 2 ** 31, 'cfg.seed'), time: oneOf(c.time, ['day', 'night'] as const, 'cfg.time'), difficulty: int(c.difficulty, 1, 6, 'cfg.difficulty'),
    met: { tempC: num(m.tempC, -40, 60, 'cfg.met.tempC'), pressureHpa: num(m.pressureHpa, 700, 1100, 'cfg.met.pressureHpa'),
      wind: [0, 1, 2].map((i) => num(m.wind?.[i], -40, 40, `cfg.met.wind[${i}]`)) as [number, number, number], latitudeDeg: num(m.latitudeDeg, -90, 90, 'cfg.met.latitudeDeg') },
  };
  if (c.weather != null) cfg.weather = oneOf(c.weather, ['clear', 'rain', 'fog', 'dust'] as const, 'cfg.weather');
  if (c.maxSec != null) cfg.maxSec = num(c.maxSec, 30, 900, 'cfg.maxSec');
  if (c.issueRounds != null) cfg.issueRounds = int(c.issueRounds, 1, 20000, 'cfg.issueRounds');
  if (c.wcs != null) cfg.wcs = oneOf(c.wcs, ['tight', 'free'] as const, 'cfg.wcs');
  if (c.checkpoints != null) cfg.checkpoints = int(c.checkpoints, 1, 12, 'cfg.checkpoints');
  if (c.traffic != null) cfg.traffic = !!c.traffic;
  return cfg;
}
function cleanPatrolActions(a: any, maxTick: number): PatrolAction[] {
  if (!Array.isArray(a) || a.length > 60000) throw new BadRequest('actions must be a list of at most 60000 entries');
  let last = 0;
  return a.map((x: any, i: number) => {
    const tick = int(x?.tick, 0, maxTick, `actions[${i}].tick`);
    if (tick < last) throw new BadRequest('actions must be in time order'); last = tick;
    const o: PatrolAction = { tick, k: oneOf(x.k, KINDS, `actions[${i}].k`) };
    for (const f of ['thr', 'str', 'az', 'el'] as const) if (x[f] != null) o[f] = num(x[f], -1, 1, `actions[${i}].${f}`);
    if (x.on != null) o.on = !!x.on;
    if (x.cid != null) o.cid = int(x.cid, 1, 10000, `actions[${i}].cid`);
    if (x.cls != null) { if (typeof x.cls !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(x.cls)) throw new BadRequest(`actions[${i}].cls is not valid`); o.cls = x.cls; }
    return o;
  });
}

/** Re-run a patrol from its seed and actions up to endTick, exactly as the browser stepped it. */
export function verifyPatrol(C: Config, W: PatrolWorld, p: any) {
  const cfg = cleanPatrolCfg(p?.cfg);
  const probe = createPatrol(cfg, W, C), maxTick = patrolMaxTicks(probe) + 10;
  const actions = cleanPatrolActions(p.actions, maxTick), endTick = int(p.endTick, 1, maxTick, 'endTick');
  const E = probe, by = new Map<number, PatrolAction[]>();
  for (const a of actions) (by.get(a.tick) ?? by.set(a.tick, []).get(a.tick)!).push(a);
  while (E.tick < endTick) stepPatrol(E, by.get(E.tick) ?? []);
  const sc = scorePatrol(E), flags: string[] = [];
  if (p.clientTotal != null && p.clientTotal !== sc.total) flags.push('client-score-mismatch');
  const chain = createHash('sha256').update(JSON.stringify(actions)).digest('hex');
  return { cfg, actions, endTick, total: sc.total, rules: sc.rules, metrics: sc.metrics as unknown as Record<string, unknown>, verified: !flags.length, flags, chain };
}

export function registerPatrol(app: FastifyInstance, db: DB, key: Buffer | null, need: (...r: string[]) => any, activeConfig: () => { id: number | null; config: Config }, W: PatrolWorld | null) {
  const history = (userId: number): PatrolRecordS[] => (db.prepare('SELECT record FROM patrol_drills WHERE user_id=? ORDER BY created_at, id').all(userId) as any[]).map((r) => JSON.parse(unseal(r.record, key)));

  app.post('/api/patrol/drills', { preHandler: need() }, async (req: FastifyRequest, reply) => {
    if (!W) return reply.code(503).send({ error: 'The patrol town (city.json) is not available on this server' });
    const v = verifyPatrol(activeConfig().config, W, req.body);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM patrol_drills WHERE user_id=?').get(req.user!.id) as any).n + 1;
    const record: PatrolRecordS = { n, date: Date.now(), cfg: v.cfg, total: v.total, rules: v.rules, metrics: v.metrics, endTick: v.endTick, verified: v.verified };
    const clientTotal = typeof (req.body as any)?.clientTotal === 'number' ? (req.body as any).clientTotal : null;
    const id = Number(db.prepare(`INSERT INTO patrol_drills(user_id,created_at,cfg,actions,end_tick,total,client_total,verified,chain,flags,record,config_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.user!.id, record.date, JSON.stringify(v.cfg), seal(JSON.stringify(v.actions), key), v.endTick, v.total, clientTotal,
      v.verified ? 1 : 0, v.chain, JSON.stringify(v.flags), seal(JSON.stringify(record), key), activeConfig().id).lastInsertRowid);
    return { id, total: v.total, verified: v.verified, flags: v.flags };
  });
  app.get('/api/patrol/drills/mine', { preHandler: need() }, async (req: FastifyRequest) => ({ drills: history(req.user!.id) }));
  app.get('/api/patrol/readiness', { preHandler: need() }, async (req: FastifyRequest) => {
    const rows = (req.user!.role === 'trainee' ? db.prepare('SELECT id,name,unit,role FROM users WHERE id=?').all(req.user!.id)
      : db.prepare("SELECT id,name,unit,role FROM users WHERE disabled=0 AND (role IN ('trainee','instructor') OR id=?) ORDER BY name").all(req.user!.id)) as any[];
    return { operators: rows.map((u) => { const H = history(u.id), recent = H.slice(-5);
      return { ...u, drills: H.length, last: H.at(-1)?.total ?? null, recent: recent.length ? Math.round(recent.reduce((a, r) => a + r.total, 0) / recent.length) : null, totals: H.slice(-20).map((r) => r.total) }; }) };
  });
  return { history };
}
