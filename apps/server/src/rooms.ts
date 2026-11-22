// Room-code multiplayer hosted by the unit server (no internet needed). On the public website one player's browser
// hosts the room and the others connect to it directly (WebRTC); on the unit server the SERVER is the host: it keeps
// the room, runs the crew drill clock (10 Hz, AI in an empty seat, the same rules as the LAN crew rooms in gun.ts),
// sets each score-fight round, collects the live scores and re-runs every player's decision log to check the score.
// Every browser is an equal player; the first player in the room (the leader) picks the rounds, and if the leader
// leaves the next player takes over. A room survives any browser closing and ends 60 s after its last player leaves.
// The messages are the same ones the browser host sends on the public site, so the room screen works unchanged.
//  - POST /api/rooms                  create a room: { code, lan: [addresses other PCs can open] }
//  - GET  /api/rooms/:code/events     Server-Sent Events for one player: "hello" { id, token }, then "msg" { from, m }
//  - POST /api/rooms/:code/send       { token, msgs: [{ to, m }] }: the player's messages to the host (the server), in order
import { randomBytes, randomInt } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  controlRoomAI, createGun, gunCrewAI, gunDone, planGun, runGun, runSim, runTotal, scoreControl, scoreField, scoreGround, scoreRun, stepGun,
  type Config, type GunAction, type GunDrillConfig, type GunEngine,
} from '@parashurama/engine';
import { cleanCfg, cleanSpawns, BadRequest } from './verify';
import { cleanGunAction, cleanGunCfg } from './gun';

interface LiveScore { score: number; kills: number; hostiles: number; }
interface Final { total: number; kills: number; hostiles: number; verified: boolean | null; quit: boolean; expert: number | null; }
interface Player { id: string; token: string; name: string; reply: FastifyReply | null; joined: boolean; live: LiveScore | null; final: Final | null; }
interface Round { n: number; kind: 'crew' | 'radar' | 'field'; label: string; cfg: any; spawns: any; ids: string[]; done: boolean; }
interface Room { code: string; players: Map<string, Player>; leader: string | null; round: Round | null; roundN: number; crew: CrewRun | null; lan: string[]; created: number; emptySince: number | null; }
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_ROOMS = 50, MAX_PLAYERS = 8;
const msg = (p: Player, m: unknown) => { if (!p.reply) return; try { p.reply.raw.write(`event: msg\ndata: ${JSON.stringify({ from: 'host', m })}\n\n`); } catch { /* gone */ } };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A crew drill on the server clock, like the LAN crew rooms: seated players send inputs, empty seats are AI. */
class CrewRun {
  seats: { cr: Player | null; gun: Player | null } = { cr: null, gun: null };
  E: GunEngine | null = null; log: GunAction[] = []; queue: GunAction[] = []; timer: NodeJS.Timeout | null = null; ended = false; scores: Record<string, number> | null = null;
  constructor(private room: Room, public cfg: GunDrillConfig, private C: Config, private onEnd: () => void, private tickMs?: number) {}
  view() { const s = this.seats; return { code: this.room.code, cfg: this.cfg, seats: { cr: s.cr?.name ?? null, gun: s.gun?.name ?? null }, ids: { cr: s.cr?.id ?? null, gun: s.gun?.id ?? null }, started: !!this.E, ended: this.ended, tick: this.E?.tick ?? 0, scores: this.scores }; }
  to(p: Player, ev: string, d: unknown) { msg(p, { t: 'crew', ev, d }); }
  all(ev: string, d: unknown) { for (const p of this.room.players.values()) this.to(p, ev, d); }
  seatOf(p: Player) { return this.seats.cr?.id === p.id ? 'cr' : this.seats.gun?.id === p.id ? 'gun' : null; }
  handle(p: Player, m: any) {
    if (m?.t === 'hello' || m?.t === 'resync') { if (m.t === 'hello') this.to(p, 'state', this.view()); if (this.E) this.to(p, 'sync', { log: this.log, tick: this.E.tick }); return; }
    if (m?.t === 'seat') {
      const s = m.seat; if (!['cr', 'gun', 'none'].includes(s)) return;
      if (this.ended) { msg(p, { t: 'err', msg: 'This crew drill has ended' }); return; }
      const taken = s !== 'none' ? this.seats[s as 'cr' | 'gun'] : null;
      if (taken && taken.id !== p.id) { msg(p, { t: 'err', msg: 'That seat is taken' }); return; }
      if (this.seats.cr?.id === p.id) this.seats.cr = null; if (this.seats.gun?.id === p.id) this.seats.gun = null;
      if (s !== 'none') this.seats[s as 'cr' | 'gun'] = p;
      this.all('state', this.view()); return;
    }
    if (m?.t === 'start') {
      if (!this.seatOf(p)) { msg(p, { t: 'err', msg: 'Take a seat first' }); return; }
      if (this.E) return;
      this.E = createGun(this.cfg, this.C);
      this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.error(e); } }, this.tickMs ?? Math.round(this.E.dt * 1000));
      this.all('state', this.view()); return;
    }
    if (m?.t === 'act') {
      const seat = this.seatOf(p); if (!seat || !this.E || this.ended || !Array.isArray(m.acts)) return;
      for (const [i, a] of m.acts.slice(0, 40).entries()) { try { this.queue.push({ tick: 0, ...cleanGunAction({ ...a, seat }, i) } as GunAction); } catch { /* malformed action: dropped */ } }
      return;
    }
    if (m?.t === 'end' && (this.seatOf(p) || this.room.leader === p.id)) this.end();
  }
  tick() {
    const E = this.E!; if (this.ended) return;
    const mine = this.queue.splice(0).map((a) => ({ ...a, tick: E.tick }));
    const ai = [...(this.seats.cr ? [] : controlRoomAI(E)), ...(this.seats.gun ? [] : gunCrewAI(E, { ackSec: 1.5 }))].map((a) => ({ ...a, tick: E.tick }));
    const acts = [...mine, ...ai];
    this.log.push(...acts); stepGun(E, acts);
    this.all('tick', { t: E.tick - 1, a: acts });
    if (gunDone(E)) this.end();
  }
  end() {
    if (this.ended) return;
    this.ended = true; if (this.timer) clearInterval(this.timer); this.timer = null;
    if (this.E) { this.scores = { cr: scoreControl(this.E).total, gun: scoreGround(this.E).total }; this.all('end', { scores: this.scores, tick: this.E.tick }); }
    this.all('state', this.view());
    if (this.room.round?.kind === 'crew') this.room.round.done = true;
    this.onEnd();
  }
  leave(p: Player) { if (this.seats.cr?.id === p.id) this.seats.cr = null; if (this.seats.gun?.id === p.id) this.seats.gun = null; this.all('state', this.view()); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

export function registerRooms(app: FastifyInstance, need: (...r: string[]) => any, activeConfig: () => { config: Config }, tickMs?: number) {
  const rooms = new Map<string, Room>();
  const roomOf = (code: unknown) => { const r = rooms.get(String(code ?? '').toUpperCase()); if (!r) throw Object.assign(new Error('No room with that code'), { statusCode: 404 }); return r; };
  const joined = (r: Room) => [...r.players.values()].filter((p) => p.joined);
  const view = (r: Room) => ({ code: r.code, lan: r.lan, round: r.round,
    players: joined(r).map((p) => ({ id: p.id, name: p.name, host: p.id === r.leader, live: p.live, final: p.final })) });
  const broadcast = (r: Room) => { const v = view(r); for (const p of joined(r)) msg(p, { t: 'room', d: v }); };
  const close = (r: Room) => { r.crew?.stop(); for (const p of r.players.values()) { try { p.reply?.raw.write('event: closed\ndata: {}\n\n'); p.reply?.raw.end(); } catch { /* gone */ } } rooms.delete(r.code); };
  // Rooms end 60 s after the last player left (a page reload keeps the room), or 10 minutes after creation if nobody came.
  const sweep = setInterval(() => {
    for (const r of rooms.values()) {
      if (r.players.size) continue;
      if ((r.emptySince ?? r.created) < Date.now() - (r.emptySince ? 60_000 : 600_000)) close(r);
    }
  }, 5_000);
  sweep.unref?.(); app.addHook('onClose', async () => { clearInterval(sweep); for (const r of [...rooms.values()]) close(r); });

  /** A score-fight round's result is complete when every player who started it has finished or left. */
  const checkDone = (r: Room) => {
    if (!r.round || r.round.done || r.round.kind === 'crew') return;
    if (!r.round.ids.some((id) => { const p = r.players.get(id); return p && p.joined && !p.final; })) r.round.done = true;
  };
  const verify = (round: Round, d: any): boolean | null => {
    try {
      const until = Math.max(1, Math.min(40000, Math.floor(num(d.endTick))));
      if (round.kind === 'radar' && Array.isArray(d.acts)) return runTotal(scoreRun(runSim(round.cfg, { actions: d.acts, until, spawns: round.spawns || undefined }, activeConfig().config))) === d.total;
      if (round.kind === 'field' && Array.isArray(d.log)) return scoreField(runGun(round.cfg, { actions: d.log, until }, activeConfig().config)).total === d.total;
    } catch { return false; }
    return null;
  };
  const startRound = (r: Room, p: Player, m: any) => {
    if (p.id !== r.leader) { msg(p, { t: 'err', msg: 'Only the room leader picks the rounds' }); return; }
    if (r.round && !r.round.done && r.round.kind !== 'crew') { msg(p, { t: 'err', msg: 'Wait for this round to finish.' }); return; }
    const C = activeConfig().config;
    let cfg: any, spawns: any = null;
    try {
      if (m.kind === 'crew') cfg = { ...planGun([], 'ground', C).cfg, seed: randomInt(1, 2 ** 31) };
      else if (m.kind === 'radar') { cfg = cleanCfg(m.cfg); spawns = m.spawns ? cleanSpawns(m.spawns, C) ?? null : null; }
      else if (m.kind === 'field') cfg = cleanGunCfg(m.cfg, C);
      else return;
    } catch (e: any) { msg(p, { t: 'err', msg: `Round not started: ${e.message}` }); return; }
    r.crew?.stop(); r.crew = null;
    for (const x of r.players.values()) { x.live = null; x.final = null; }
    const label = String(m.label ?? '').replace(/[<>]/g, '').slice(0, 80) || m.kind;
    r.round = { n: ++r.roundN, kind: m.kind, label, cfg, spawns, ids: joined(r).map((x) => x.id), done: false };
    if (m.kind === 'crew') r.crew = new CrewRun(r, cfg, C, () => broadcast(r), tickMs);
    broadcast(r);
  };
  const handle = (r: Room, p: Player, m: any) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      if (p.joined) return;
      let name = String(m.name ?? 'Player').replace(/[<>]/g, '').trim().slice(0, 24) || 'Player';
      for (let i = 2; joined(r).some((x) => x.name === name); i++) name = `${name.replace(/ \d+$/, '')} ${i}`;
      p.name = name; p.joined = true; if (!r.leader) r.leader = p.id;
      msg(p, { t: 'welcome', id: p.id }); broadcast(r); return;
    }
    if (!p.joined) return;
    if (m.t === 'startRound') { startRound(r, p, m); return; }
    if (m.t === 'crew') { r.crew?.handle(p, m.m ?? {}); return; }
    const round = r.round;
    if (!round || round.kind === 'crew' || !round.ids.includes(p.id)) return;
    if (m.t === 'live' && !p.final) { const d = m.d ?? {}; p.live = { score: num(d.score), kills: num(d.kills), hostiles: num(d.hostiles) }; broadcast(r); return; }
    if (m.t === 'final' && !p.final) {
      const d = m.d ?? {};
      p.final = { total: Math.round(num(d.total)), kills: num(d.kills), hostiles: num(d.hostiles), quit: !!d.quit, expert: d.expert == null ? null : num(d.expert), verified: verify(round, d) };
      p.live = { score: p.final.total, kills: p.final.kills, hostiles: p.final.hostiles };
      checkDone(r); broadcast(r);
    }
  };

  app.post('/api/rooms', { preHandler: need() }, async (req: any, reply: FastifyReply) => {
    if (rooms.size >= MAX_ROOMS) return reply.code(429).send({ error: 'Too many rooms on this server' });
    let code = ''; do code = Array.from({ length: 5 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join(''); while (rooms.has(code));
    const port = req.socket?.localPort, proto = req.protocol === 'https' ? 'https' : 'http';
    const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `${proto}://${i!.address}:${port}`);
    rooms.set(code, { code, players: new Map(), leader: null, round: null, roundN: 0, crew: null, lan, created: Date.now(), emptySince: null });
    return { code, lan };
  });

  app.get('/api/rooms/:code/events', { preHandler: need() }, (req: any, reply: FastifyReply) => {
    const r = roomOf(req.params.code);
    if (r.players.size >= MAX_PLAYERS) return reply.code(409).send({ error: 'This room is full' });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
    const p: Player = { id: `p${randomBytes(5).toString('hex')}`, token: randomBytes(16).toString('hex'), name: 'Player', reply, joined: false, live: null, final: null };
    r.players.set(p.id, p); r.emptySince = null;
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ id: p.id, token: p.token })}\n\n`);
    const ping = setInterval(() => { try { reply.raw.write(': ping\n\n'); } catch { /* gone */ } }, 15_000);
    req.raw.on('close', () => {
      clearInterval(ping); p.reply = null;
      if (!r.players.delete(p.id)) return;
      r.crew?.leave(p);
      if (r.leader === p.id) r.leader = joined(r)[0]?.id ?? null; // the next player takes over picking rounds
      if (!r.players.size) r.emptySince = Date.now();
      checkDone(r); broadcast(r);
    });
  });

  app.post('/api/rooms/:code/send', { preHandler: need() }, async (req: any) => {
    const r = roomOf(req.params.code), b = req.body ?? {};
    const p = typeof b.token === 'string' ? [...r.players.values()].find((x) => x.token === b.token) : undefined;
    if (!p) throw Object.assign(new Error('Not in this room'), { statusCode: 403 });
    if (!Array.isArray(b.msgs) || b.msgs.length > 200) throw new BadRequest('msgs must be a list of at most 200 messages');
    for (const x of b.msgs) handle(r, p, x?.m);
    return { ok: true };
  });
  return { rooms };
}
