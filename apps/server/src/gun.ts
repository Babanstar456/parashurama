import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  chainHashGun, controlRoomAI, createGun, gunCrewAI, gunDone, gunMastery, gunsOf, observeGun, planGun, runGun, scoreControl, scoreGround, scoreReload, stepGun,
  type Config, type GunAction, type GunDrillConfig, type GunEngine, type GunGame, type GunRecord, type GunScore,
} from '@parashurama/engine';
import { audit, type DB } from './db';
import { open as unseal, seal } from './crypto';
import type { User } from './auth';
import { BadRequest } from './verify';

/**
 * Gun detachment drills on the unit server.
 *  - Solo drills (one trainee + an AI seat) are re-run here from the seed and the trainee's own actions, with the AI seat
 *    replayed by the real AI (so a client cannot forge orders from the "AI" control room).
 *  - Crew drills over the LAN: the server runs the drill at 10 Hz and is the only authority. Seated trainees POST their
 *    inputs; every tick's actions are pushed to all clients with Server-Sent Events, and each client runs the same
 *    deterministic engine. Empty seats are played by the AI. No extra dependency, plain HTTP(S) on the unit network.
 */
const int = (v: any, lo: number, hi: number, n: string) => { if (!Number.isInteger(v) || v < lo || v > hi) throw new BadRequest(`${n} must be an integer between ${lo} and ${hi}`); return v; };
const num = (v: any, lo: number, hi: number, n: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new BadRequest(`${n} must be a number between ${lo} and ${hi}`); return v; };
const oneOf = <T extends string>(v: any, list: readonly T[], n: string): T => { if (!list.includes(v)) throw new BadRequest(`${n} must be one of: ${list.join(', ')}`); return v; };
const opt = <T>(v: any, f: (x: any) => T) => (v == null ? undefined : f(v));

export function cleanGunCfg(c: any, C: Config): GunDrillConfig {
  if (!c || typeof c !== 'object') throw new BadRequest('cfg is required');
  const m = c.met ?? {}, G = gunsOf(C);
  const cfg: GunDrillConfig = {
    seed: int(c.seed, 0, 2 ** 32 - 1, 'cfg.seed'), gun: oneOf(c.gun, Object.keys(G.guns), 'cfg.gun'),
    time: oneOf(c.time, ['day', 'night'] as const, 'cfg.time'), terrain: oneOf(c.terrain, ['urban', 'rural'] as const, 'cfg.terrain'),
    difficulty: int(c.difficulty, 1, 6, 'cfg.difficulty'), issueRounds: int(c.issueRounds, 1, 5000, 'cfg.issueRounds'), stoppages: !!c.stoppages,
    met: { tempC: num(m.tempC, -40, 60, 'cfg.met.tempC'), pressureHpa: num(m.pressureHpa, 700, 1100, 'cfg.met.pressureHpa'),
      wind: [0, 1, 2].map((i) => num(m.wind?.[i], -40, 40, `cfg.met.wind[${i}]`)) as [number, number, number], latitudeDeg: num(m.latitudeDeg, -90, 90, 'cfg.met.latitudeDeg') },
  };
  const w = opt(c.weather, (x) => oneOf(x, ['clear', 'rain', 'fog', 'dust'] as const, 'cfg.weather')); if (w) cfg.weather = w;
  const rf = opt(c.radarFault, (x) => !!x); if (rf != null) cfg.radarFault = rf;
  const ms = opt(c.maxSec, (x) => num(x, 30, 600, 'cfg.maxSec')); if (ms != null) cfg.maxSec = ms;
  const wcs = opt(c.wcs, (x) => oneOf(x, ['hold', 'tight', 'free'] as const, 'cfg.wcs')); if (wcs) cfg.wcs = wcs;
  const adw = opt(c.adw, (x) => oneOf(x, ['white', 'yellow', 'red'] as const, 'cfg.adw')); if (adw) cfg.adw = adw;
  const pr = opt(c.practice, (x) => oneOf(x, ['reload'] as const, 'cfg.practice')); if (pr) cfg.practice = pr;
  if (c.safeArcs != null) {
    if (!Array.isArray(c.safeArcs) || c.safeArcs.length > 4) throw new BadRequest('cfg.safeArcs must be a list of at most 4 arcs');
    cfg.safeArcs = c.safeArcs.map((a: any, i: number) => [num(a?.[0], 0, 360, `cfg.safeArcs[${i}][0]`), num(a?.[1], 0, 360, `cfg.safeArcs[${i}][1]`)] as [number, number]);
  }
  return cfg;
}
const KINDS = ['order', 'check', 'uxo', 'rstep', 'ack', 'post', 'kill', 'load', 'safety', 'lay', 'slew', 'trig', 'sight', 'lock', 'clear', 'barrel', 'unload', 'report'] as const;
const ORDERS = ['rangeClear', 'alert', 'target', 'method', 'engage', 'cease', 'hold', 'unload', 'rangeGreen'] as const;
/** One action, without its tick (the server stamps crew actions; solo logs carry their own). */
export function cleanGunAction(x: any, i: number): Omit<GunAction, 'tick'> {
  const a: any = { seat: oneOf(x?.seat, ['cr', 'gun'] as const, `actions[${i}].seat`), k: oneOf(x?.k, KINDS, `actions[${i}].k`) };
  if (x.o != null) a.o = oneOf(x.o, ORDERS, `actions[${i}].o`);
  if (x.cid != null) a.cid = int(x.cid, 1, 1000, `actions[${i}].cid`);
  if (x.on != null) a.on = !!x.on;
  for (const f of ['az', 'el'] as const) if (x[f] != null) a[f] = num(x[f], -1, 1, `actions[${i}].${f}`);
  if (x.spd != null) a.spd = num(x.spd, 0, 400, `actions[${i}].spd`);
  if (x.crs != null) a.crs = num(x.crs, -180, 180, `actions[${i}].crs`);
  if (x.rng != null) a.rng = num(x.rng, 0, 10000, `actions[${i}].rng`);
  if (x.n != null) a.n = int(x.n, -100000, 100000, `actions[${i}].n`);
  if (x.out != null) a.out = oneOf(x.out, ['destroyed', 'noEffect'] as const, `actions[${i}].out`);
  if (x.item != null) { if (typeof x.item !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(x.item)) throw new BadRequest(`actions[${i}].item is not valid`); a.item = x.item; }
  if (x.i != null) a.i = int(x.i, 0, 1e6, `actions[${i}].i`);
  return a;
}
function cleanGunActions(a: any, maxTick: number): GunAction[] {
  if (!Array.isArray(a) || a.length > 30000) throw new BadRequest('actions must be a list of at most 30000 entries');
  let last = 0;
  return a.map((x: any, i: number) => {
    const tick = int(x?.tick, 0, maxTick, `actions[${i}].tick`);
    if (tick < last) throw new BadRequest('actions must be in time order'); last = tick;
    return { tick, ...cleanGunAction(x, i) } as GunAction;
  });
}
const maxTicksFor = (C: Config, cfg: GunDrillConfig) => Math.round(((cfg.maxSec ?? 180) + 90) / C.training.sim.dt) + 10;
export const scoreFor = (E: GunEngine, game: GunGame): GunScore => (E.cfg.practice ? scoreReload(E) : game === 'ground' ? scoreGround(E) : scoreControl(E));
const mySeat = (game: GunGame) => (game === 'control' ? 'cr' : 'gun');

/** Re-run a solo gun drill: the trainee's seat from the log, the other seat by the AI itself. */
export async function verifyGun(C: Config, p: any) {
  const game = oneOf(p?.game, ['ground', 'control'] as const, 'game');
  const cfg = cleanGunCfg(p.cfg, C), maxTick = maxTicksFor(C, cfg);
  const all = cleanGunActions(p.actions, maxTick), endTick = int(p.endTick, 1, maxTick, 'endTick');
  const mine = all.filter((a) => a.seat === mySeat(game));
  const ai = cfg.practice ? [] : game === 'control' ? [(E: GunEngine) => gunCrewAI(E, { ackSec: 1.5 })] : [controlRoomAI];
  const E = runGun(cfg, { actions: mine, policies: ai, until: endTick }, C);
  const sc = scoreFor(E, game), flags: string[] = [];
  if (p.clientTotal != null && p.clientTotal !== sc.total) flags.push('client-score-mismatch');
  const record: GunRecord & { crew?: string } = { n: 0, date: Date.now(), game, cfg, total: sc.total, obs: observeGun(sc), metrics: sc.metrics, rules: sc.rules, endTick };
  return { game, cfg, actions: mine, endTick, total: sc.total, verified: !flags.length, flags, chain: await chainHashGun(mine), record };
}

// ---------- crew rooms (LAN) ----------
interface Client { reply: FastifyReply; user: User; }
interface Room {
  code: string; cfg: GunDrillConfig; by: number; seats: { cr: User | null; gun: User | null }; E: GunEngine | null; log: GunAction[];
  queue: GunAction[]; clients: Set<Client>; timer: NodeJS.Timeout | null; ended: boolean; scores: Record<string, number> | null; touched: number;
}
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function registerGun(app: FastifyInstance, db: DB, key: Buffer | null, need: (...r: string[]) => any, activeConfig: () => { id: number | null; config: Config }, tickMs?: number) {
  const store = (userId: number, rec: any, actions: GunAction[], v: { game: GunGame; cfg: GunDrillConfig; endTick: number; total: number; verified: boolean; flags: string[]; chain: string }, crew: string | null, clientTotal: number | null) => {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM gun_drills WHERE user_id=? AND game=?').get(userId, v.game) as any).n + 1;
    const record = { ...rec, n, ...(crew ? { crew } : {}) };
    return Number(db.prepare(`INSERT INTO gun_drills(user_id,created_at,game,crew,cfg,actions,end_tick,total,client_total,verified,chain,flags,record,config_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(userId, Date.now(), v.game, crew, JSON.stringify(v.cfg), seal(JSON.stringify(actions), key), v.endTick, v.total, clientTotal,
      v.verified ? 1 : 0, v.chain, JSON.stringify(v.flags), seal(JSON.stringify(record), key), activeConfig().id).lastInsertRowid);
  };
  const history = (userId: number): GunRecord[] => (db.prepare('SELECT record FROM gun_drills WHERE user_id=? ORDER BY created_at, id').all(userId) as any[]).map((r) => JSON.parse(unseal(r.record, key)));

  app.post('/api/gun/drills', { preHandler: need() }, async (req: FastifyRequest) => {
    const v = await verifyGun(activeConfig().config, req.body ?? {});
    const id = store(req.user!.id, v.record, v.actions, v, null, (req.body as any)?.clientTotal ?? null);
    if (v.flags.length) audit(db, req.user!.id, 'gun-drill-flagged', `#${id} ${v.flags.join(',')}`);
    return { id, total: v.total, verified: v.verified, flags: v.flags, chain: v.chain };
  });
  app.get('/api/gun/drills/mine', { preHandler: need() }, async (req: FastifyRequest) => ({ drills: history(req.user!.id) }));
  app.get('/api/gun/readiness', { preHandler: need() }, async (req: FastifyRequest) => {
    const C = activeConfig().config;
    const rows = (req.user!.role === 'trainee' ? db.prepare('SELECT id,name,unit,role FROM users WHERE id=?').all(req.user!.id)
      : db.prepare("SELECT id,name,unit,role FROM users WHERE disabled=0 AND (role IN ('trainee','instructor') OR id=?) ORDER BY name").all(req.user!.id)) as any[];
    return { operators: rows.map((u) => { const H = history(u.id), last = (g: GunGame) => H.filter((h) => h.game === g).at(-1)?.total ?? null;
      return { ...u, mastery: gunMastery(H, C), drills: H.length, lastGround: last('ground'), lastControl: last('control') }; }) };
  });

  const rooms = new Map<string, Room>();
  const send = (c: Client, ev: string, data: unknown, id?: number) => { try { c.reply.raw.write(`${id != null ? `id: ${id}\n` : ''}event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };
  const view = (r: Room) => ({ code: r.code, cfg: r.cfg, seats: { cr: r.seats.cr?.name ?? null, gun: r.seats.gun?.name ?? null }, started: !!r.E, ended: r.ended, tick: r.E?.tick ?? 0, scores: r.scores });
  const broadcast = (r: Room, ev: string, data: unknown, id?: number) => { for (const c of r.clients) send(c, ev, data, id); };
  const room = (code: string) => { const r = rooms.get(String(code).toUpperCase()); if (!r) throw Object.assign(new Error('No such crew'), { statusCode: 404 }); r.touched = Date.now(); return r; };
  const seatOf = (r: Room, u: User) => (r.seats.cr?.id === u.id ? 'cr' : r.seats.gun?.id === u.id ? 'gun' : null);
  // Rooms with nobody watching for 15 minutes are closed.
  const sweep = setInterval(() => { for (const [k, r] of rooms) if (Date.now() - r.touched > 15 * 60_000 && !r.clients.size) { if (r.timer) clearInterval(r.timer); rooms.delete(k); } }, 60_000);
  sweep.unref?.(); app.addHook('onClose', async () => { clearInterval(sweep); for (const r of rooms.values()) { if (r.timer) clearInterval(r.timer); for (const c of r.clients) c.reply.raw.end(); } });

  async function endRoom(r: Room) {
    if (r.ended || !r.E) return;
    r.ended = true; if (r.timer) clearInterval(r.timer); r.timer = null;
    const E = r.E, C = E.C, scores: Record<string, number> = {};
    // Sanity: the stored log must reproduce the live drill.
    const R = runGun(E.cfg, { actions: r.log, until: E.tick }, C), chain = await chainHashGun(r.log);
    for (const seat of ['cr', 'gun'] as const) {
      const u = r.seats[seat]; const game: GunGame = seat === 'cr' ? 'control' : 'ground';
      const sc = scoreFor(E, game), sc2 = scoreFor(R, game); scores[seat] = sc.total;
      if (!u) continue;
      const rec: GunRecord = { n: 0, date: Date.now(), game, cfg: E.cfg, total: sc.total, obs: observeGun(sc), metrics: sc.metrics, rules: sc.rules, endTick: E.tick };
      store(u.id, rec, r.log, { game, cfg: E.cfg, endTick: E.tick, total: sc.total, verified: sc2.total === sc.total, flags: sc2.total === sc.total ? [] : ['replay-mismatch'], chain }, r.code, null);
    }
    r.scores = scores; audit(db, r.by, 'crew-drill', `${r.code} cr=${r.seats.cr?.username ?? 'AI'} gun=${r.seats.gun?.username ?? 'AI'} ${JSON.stringify(scores)}`);
    broadcast(r, 'end', { scores, chain, tick: E.tick });
    broadcast(r, 'state', view(r));
  }
  function tick(r: Room) {
    const E = r.E!;
    const mine = r.queue.splice(0).map((a) => ({ ...a, tick: E.tick }));
    const ai = [...(r.seats.cr ? [] : controlRoomAI(E)), ...(r.seats.gun ? [] : gunCrewAI(E, { ackSec: 1.5 }))].map((a) => ({ ...a, tick: E.tick }));
    const acts = [...mine, ...ai];
    r.log.push(...acts); stepGun(E, acts);
    broadcast(r, 'tick', { t: E.tick - 1, a: acts }, E.tick - 1);
    if (gunDone(E)) void endRoom(r);
  }

  app.get('/api/crews', { preHandler: need() }, async () => ({ crews: [...rooms.values()].filter((r) => !r.ended).map(view) }));
  app.post('/api/crews', { preHandler: need() }, async (req: FastifyRequest, reply: FastifyReply) => {
    if ([...rooms.values()].filter((r) => !r.ended).length >= 50) return reply.code(429).send({ error: 'Too many crew drills running on this server' });
    const C = activeConfig().config, b: any = req.body ?? {};
    const cfg = b.cfg ? cleanGunCfg(b.cfg, C) : { ...planGun([], 'ground', C).cfg, seed: randomInt(1, 2 ** 31) };
    let code = ''; do code = Array.from({ length: 5 }, () => CODE[randomInt(CODE.length)]).join(''); while (rooms.has(code));
    rooms.set(code, { code, cfg, by: req.user!.id, seats: { cr: null, gun: null }, E: null, log: [], queue: [], clients: new Set(), timer: null, ended: false, scores: null, touched: Date.now() });
    audit(db, req.user!.id, 'crew-create', code);
    return view(rooms.get(code)!);
  });
  app.post('/api/crews/:code/seat', { preHandler: need() }, async (req: any, reply: FastifyReply) => {
    const r = room(req.params.code), seat = oneOf(req.body?.seat, ['cr', 'gun', 'none'] as const, 'seat'), u = req.user as User;
    if (r.ended) return reply.code(409).send({ error: 'This crew drill has ended' });
    if (seat !== 'none' && r.seats[seat] && r.seats[seat]!.id !== u.id) return reply.code(409).send({ error: 'That seat is taken' });
    if (r.seats.cr?.id === u.id) r.seats.cr = null; if (r.seats.gun?.id === u.id) r.seats.gun = null;
    if (seat !== 'none') r.seats[seat] = u;
    broadcast(r, 'state', view(r)); return view(r);
  });
  app.post('/api/crews/:code/start', { preHandler: need() }, async (req: any, reply: FastifyReply) => {
    const r = room(req.params.code);
    if (!seatOf(r, req.user) && r.by !== req.user.id) return reply.code(403).send({ error: 'Take a seat first' });
    if (r.E) return view(r);
    r.E = createGun(r.cfg, activeConfig().config);
    r.timer = setInterval(() => { try { tick(r); } catch (e) { app.log.error(e); } }, tickMs ?? Math.round(r.E.dt * 1000));
    broadcast(r, 'state', view(r)); return view(r);
  });
  app.post('/api/crews/:code/act', { preHandler: need() }, async (req: any, reply: FastifyReply) => {
    const r = room(req.params.code), seat = seatOf(r, req.user);
    if (!seat) return reply.code(403).send({ error: 'You have no seat in this crew' });
    if (!r.E || r.ended) return reply.code(409).send({ error: 'The drill is not running' });
    const acts = req.body?.acts;
    if (!Array.isArray(acts) || acts.length > 40) throw new BadRequest('acts must be a list of at most 40 actions');
    // The seat is the sender's own, whatever the client says.
    for (const [i, a] of acts.entries()) r.queue.push({ tick: 0, ...cleanGunAction({ ...a, seat }, i) } as GunAction);
    return { ok: true, tick: r.E.tick };
  });
  app.post('/api/crews/:code/end', { preHandler: need() }, async (req: any, reply: FastifyReply) => {
    const r = room(req.params.code);
    if (!seatOf(r, req.user) && r.by !== req.user.id) return reply.code(403).send({ error: 'Only the crew can end this drill' });
    if (r.E) await endRoom(r); else { r.ended = true; broadcast(r, 'state', view(r)); }
    return view(r);
  });
  // Live feed: the full log on connect (so a reconnect rebuilds exactly), then every tick.
  app.get('/api/crews/:code/events', { preHandler: need() }, (req: any, reply: FastifyReply) => {
    const r = room(req.params.code);
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
    const c: Client = { reply, user: req.user };
    r.clients.add(c);
    send(c, 'state', view(r));
    if (r.E) send(c, 'sync', { log: r.log, tick: r.E.tick });
    if (r.ended && r.scores) send(c, 'end', { scores: r.scores, tick: r.E?.tick ?? 0 });
    const ping = setInterval(() => { try { reply.raw.write(': ping\n\n'); } catch { /* gone */ } }, 15_000);
    req.raw.on('close', () => { clearInterval(ping); r.clients.delete(c); r.touched = Date.now(); });
  });
  return { rooms };
}
