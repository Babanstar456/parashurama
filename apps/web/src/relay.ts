// Room-code multiplayer through the unit server (no internet needed): the same host / guest connections as p2p.ts,
// relayed by the server (apps/server/src/rooms.ts) instead of direct WebRTC. multiplayer.ts uses this on the unit server
// and p2p.ts on the public website; everything above the connection (rounds, scoring, re-run checks) is the same.
import { api } from './online';
import type { RoomHost, RoomWire } from './p2p';

/** Sends in order: one request at a time, and messages queued meanwhile go together in the next one. */
function sender(code: string, token: () => string) {
  let q: { to: string; m: unknown }[] = [], busy = false, dead = false;
  const flush = async () => {
    if (busy || dead || !q.length) return;
    busy = true; const msgs = q.splice(0, 200);
    try { await api(`/api/rooms/${code}/send`, { method: 'POST', body: JSON.stringify({ token: token(), msgs }) }); } catch { /* room gone: the event stream reports it */ }
    busy = false; void flush();
  };
  return { push: (to: string, m: unknown) => { if (dead) return; q.push({ to, m }); void flush(); }, stop: () => { dead = true; q = []; } };
}

/** Open the room's event stream; resolves with the server's hello once connected, rejects if the room cannot be joined. */
function openStream(url: string): Promise<{ es: EventSource; id: string; token: string }> {
  return new Promise((ok, bad) => {
    const es = new EventSource(url);
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; es.close(); bad(new Error('The unit server did not answer.')); } }, 10000);
    es.addEventListener('hello', (e: MessageEvent) => { if (done) return; done = true; clearTimeout(t); const d = JSON.parse(e.data); ok({ es, id: d.id, token: d.token }); });
    es.onerror = () => { if (done) return; done = true; clearTimeout(t); es.close(); bad(new Error('No room with that code on this server (or it is full).')); };
  });
}

export class RelayHost implements RoomHost {
  onjoin: (id: string) => void = () => undefined; onleave: (id: string) => void = () => undefined; onmsg: (id: string, m: any) => void = () => undefined;
  private out: ReturnType<typeof sender>;
  private constructor(public code: string, public lan: string[], private es: EventSource, token: string) {
    this.out = sender(code, () => token);
    es.addEventListener('join', (e: MessageEvent) => this.onjoin(JSON.parse(e.data).id));
    es.addEventListener('leave', (e: MessageEvent) => this.onleave(JSON.parse(e.data).id));
    es.addEventListener('msg', (e: MessageEvent) => { const d = JSON.parse(e.data); this.onmsg(d.from, d.m); });
  }
  static async create(): Promise<RelayHost> {
    const r = await api('/api/rooms', { method: 'POST', body: '{}' });
    const s = await openStream(`/api/rooms/${r.code}/events?role=host`);
    return new RelayHost(r.code, r.lan ?? [], s.es, s.token);
  }
  send(id: string, m: unknown) { this.out.push(id, m); }
  broadcast(m: unknown) { this.out.push('*', m); }
  close() { this.out.stop(); this.es.close(); }
}

export async function relayJoin(code: string): Promise<RoomWire> {
  const s = await openStream(`/api/rooms/${code}/events?role=guest`);
  const out = sender(code, () => s.token);
  let closed = false;
  const w: RoomWire = {
    onmsg: () => undefined, onclose: () => undefined,
    send: (m) => out.push('host', m),
    close: () => { if (closed) return; closed = true; out.stop(); s.es.close(); w.onclose(); },
  };
  s.es.addEventListener('msg', (e: MessageEvent) => w.onmsg(JSON.parse(e.data).m));
  s.es.addEventListener('closed', () => w.close());
  s.es.onerror = () => w.close(); // the server or the host went away (no automatic reconnect: it would be a new player)
  return w;
}
