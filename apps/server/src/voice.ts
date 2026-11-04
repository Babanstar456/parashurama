// Push-to-talk voice net (radio): live speech between the stations on the unit server.
// A station holds the mic and sends short chunks of 16-bit mono PCM (about 0.12 s each); the server relays each chunk at
// once to every other station listening on the same net (Server-Sent Events) and keeps nothing: no recording, no log of
// what was said. Nets: "unit" (everyone on the server) or "crew-<code>" (the two seats of a LAN crew drill).
// Stations are anonymous callsigns chosen by the browser ("Station 4F2", "Gun", "Control Room"): no names (DPDP).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { BadRequest } from './verify';

interface Listener { reply: FastifyReply; station: string; }
const NET = /^(unit|crew-[A-Za-z0-9]{2,12})$/;
const STATION = /^[A-Za-z0-9 \-]{1,24}$/;
/** Largest chunk accepted (base64 of 16-bit PCM): 0.5 s at 24 kHz is 24 000 bytes, so 64 KB leaves room. */
const MAX_CHUNK_B64 = 65_536;

export function registerVoice(app: FastifyInstance, need: (...r: string[]) => any) {
  const nets = new Map<string, Set<Listener>>();
  const send = (l: Listener, ev: string, data: unknown) => { try { l.reply.raw.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* station gone */ } };
  const netOf = (name: string) => { if (!NET.test(name)) throw new BadRequest('unknown voice net'); let s = nets.get(name); if (!s) { s = new Set(); nets.set(name, s); } return s; };
  const stationOf = (x: unknown) => { const s = String(x ?? '').trim(); if (!STATION.test(s)) throw new BadRequest('station callsign: 1–24 letters, digits, spaces or dashes'); return s; };
  const peers = (s: Set<Listener>) => { const n = new Set([...s].map((l) => l.station)).size; for (const l of s) send(l, 'peers', { n }); };

  // Listen to a net.
  app.get('/api/voice/:net/events', { preHandler: need() }, (req: any, reply: FastifyReply) => {
    const s = netOf(req.params.net), station = stationOf(req.query?.station);
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
    const l: Listener = { reply, station };
    s.add(l); peers(s);
    const ping = setInterval(() => { try { reply.raw.write(': ping\n\n'); } catch { /* gone */ } }, 15_000);
    req.raw.on('close', () => { clearInterval(ping); s.delete(l); if (s.size) peers(s); else nets.delete(req.params.net); });
  });

  // Transmit: one chunk of speech, or the start / end of a transmission (pcm missing). Relayed to the other stations only.
  app.post('/api/voice/:net', { preHandler: need() }, async (req: any) => {
    const s = netOf(req.params.net), b = req.body ?? {}, station = stationOf(b.station);
    const seq = Number(b.seq), sr = Number(b.sr);
    if (!Number.isInteger(seq) || seq < 0) throw new BadRequest('seq must be a whole number');
    if (b.pcm != null) {
      if (typeof b.pcm !== 'string' || b.pcm.length > MAX_CHUNK_B64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.pcm)) throw new BadRequest('pcm must be base64 PCM, at most 64 KB');
      if (![8000, 12000, 16000, 24000].includes(sr)) throw new BadRequest('sr must be 8000, 12000, 16000 or 24000');
    }
    const ev = b.pcm != null ? 'audio' : 'talk', data = b.pcm != null ? { from: station, seq, sr, pcm: b.pcm } : { from: station, seq, on: !!b.on };
    let n = 0;
    for (const l of s) if (l.station !== station) { send(l, ev, data); n++; }
    return { ok: true, heard: n };
  });

  return { nets };
}
