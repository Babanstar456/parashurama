// Room-code multiplayer on the unit server (no internet needed). On the public website the browsers in a room talk to
// each other directly (WebRTC); here the unit server relays the same messages instead: crew rounds, score fights and
// their results. The host's browser still runs the room; the server only passes messages on and keeps nothing.
//  - POST /api/rooms                  create a room: { code, lan: [addresses other PCs can open] }
//  - GET  /api/rooms/:code/events     Server-Sent Events; ?role=host (one) or guest. First event "hello" { id, token }.
//      host receives "join" { id }, "leave" { id } and "msg" { from, m }; a guest receives "msg" and "closed".
//  - POST /api/rooms/:code/send       { token, msgs: [{ to, m }] }, in order: the host sends to a guest id or "*" (all);
//      a guest can send only to the host.
import { randomBytes, randomInt } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { BadRequest } from './verify';

interface Peer { id: string; token: string; reply: FastifyReply; }
interface Room { code: string; host: Peer | null; guests: Map<string, Peer>; created: number; }
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_ROOMS = 50, MAX_GUESTS = 7;

export function registerRooms(app: FastifyInstance, need: (...r: string[]) => any) {
  const rooms = new Map<string, Room>();
  const emit = (p: Peer, ev: string, data: unknown) => { try { p.reply.raw.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ } };
  const roomOf = (code: unknown) => { const r = rooms.get(String(code ?? '').toUpperCase()); if (!r) throw Object.assign(new Error('No room with that code'), { statusCode: 404 }); return r; };
  // A room nobody joined within 10 minutes of being created is dropped.
  const sweep = setInterval(() => { for (const [k, r] of rooms) if (!r.host && !r.guests.size && Date.now() - r.created > 600_000) rooms.delete(k); }, 60_000);
  sweep.unref?.(); app.addHook('onClose', async () => { clearInterval(sweep); for (const r of rooms.values()) for (const p of [r.host, ...r.guests.values()]) p?.reply.raw.end(); });

  app.post('/api/rooms', { preHandler: need() }, async (req: any, reply: FastifyReply) => {
    if (rooms.size >= MAX_ROOMS) return reply.code(429).send({ error: 'Too many rooms on this server' });
    let code = ''; do code = Array.from({ length: 5 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join(''); while (rooms.has(code));
    rooms.set(code, { code, host: null, guests: new Map(), created: Date.now() });
    // Addresses the other players can open (this server's network addresses, same port and protocol).
    const port = req.socket?.localPort, proto = req.protocol === 'https' ? 'https' : 'http';
    const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `${proto}://${i!.address}:${port}`);
    return { code, lan };
  });

  app.get('/api/rooms/:code/events', { preHandler: need() }, (req: any, reply: FastifyReply) => {
    const r = roomOf(req.params.code), host = req.query?.role === 'host';
    if (host && r.host) return reply.code(409).send({ error: 'This room already has a host' });
    if (!host && !r.host) return reply.code(404).send({ error: 'No room with that code' });
    if (!host && r.guests.size >= MAX_GUESTS) return reply.code(409).send({ error: 'This room is full' });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
    const p: Peer = { id: host ? 'host' : `g${randomBytes(5).toString('hex')}`, token: randomBytes(16).toString('hex'), reply };
    if (host) r.host = p; else { r.guests.set(p.id, p); emit(r.host!, 'join', { id: p.id }); }
    emit(p, 'hello', { id: p.id, token: p.token });
    const ping = setInterval(() => { try { reply.raw.write(': ping\n\n'); } catch { /* gone */ } }, 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      if (host) { for (const g of r.guests.values()) { emit(g, 'closed', {}); g.reply.raw.end(); } rooms.delete(r.code); }
      else if (r.guests.delete(p.id) && r.host) emit(r.host, 'leave', { id: p.id });
    });
  });

  app.post('/api/rooms/:code/send', { preHandler: need() }, async (req: any) => {
    const r = roomOf(req.params.code), b = req.body ?? {};
    const from = r.host?.token === b.token ? r.host : [...r.guests.values()].find((g) => g.token === b.token);
    if (!from || typeof b.token !== 'string') throw Object.assign(new Error('Not in this room'), { statusCode: 403 });
    if (!Array.isArray(b.msgs) || b.msgs.length > 200) throw new BadRequest('msgs must be a list of at most 200 messages');
    for (const x of b.msgs) {
      if (from.id === 'host') {
        if (x?.to === '*') for (const g of r.guests.values()) emit(g, 'msg', { from: 'host', m: x.m });
        else { const g = r.guests.get(String(x?.to)); if (g) emit(g, 'msg', { from: 'host', m: x.m }); }
      } else if (r.host) emit(r.host, 'msg', { from: from.id, m: x?.m });
    }
    return { ok: true };
  });
  return { rooms };
}
