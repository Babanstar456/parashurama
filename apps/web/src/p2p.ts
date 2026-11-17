// Room-code multiplayer without a unit server (the public website). Browsers talk to each other directly over an
// encrypted WebRTC data channel. A public signalling broker (the PeerJS cloud broker by default; set VITE_CREW_BROKER
// to self-host one) is used only for the handshake: it relays the connection offer, answer and network candidates,
// never drill data. The host's broker id is derived from the room code, so a code is all a guest needs.
// No dependency: the broker's message protocol (OPEN / OFFER / ANSWER / CANDIDATE / EXPIRE / LEAVE / HEARTBEAT) is
// spoken directly. Star topology: every guest connects to the host; the host relays.

const env = (import.meta as any).env ?? {};
const BROKER: string = env.VITE_CREW_BROKER || 'wss://0.peerjs.com:443/peerjs';
const ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (env.VITE_TURN_URL) ICE.push({ urls: env.VITE_TURN_URL, username: env.VITE_TURN_USER, credential: env.VITE_TURN_PASS });
const PREFIX = 'parashuramaRoom';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CHUNK = 15000;

const rnd = (n: number, chars = 'abcdefghijkmnpqrstuvwxyz23456789') => { const a = new Uint32Array(n); crypto.getRandomValues(a); return Array.from(a, (x) => chars[x % chars.length]).join(''); };
export const newCode = () => rnd(5, CODE_CHARS);
export const cleanCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
export const p2pSupported = () => typeof RTCPeerConnection === 'function' && typeof WebSocket === 'function';

/** Connection to the signalling broker. */
class Broker {
  ws!: WebSocket; hb = 0; onmsg: (m: any) => void = () => undefined; onlost: () => void = () => undefined;
  static open(id: string): Promise<Broker> {
    const b = new Broker();
    return new Promise((ok, bad) => {
      let done = false;
      const fail = (msg: string) => { if (done) return; done = true; b.close(); bad(new Error(msg)); };
      const t = setTimeout(() => fail('The signalling service did not answer. Check the internet connection.'), 10000);
      try { b.ws = new WebSocket(`${BROKER}?key=peerjs&id=${encodeURIComponent(id)}&token=${rnd(12)}&version=1.5.4`); } catch { fail('Could not reach the signalling service.'); return; }
      b.ws.onmessage = (e) => {
        let m: any; try { m = JSON.parse(e.data); } catch { return; }
        if (!done) {
          if (m.type === 'OPEN') { done = true; clearTimeout(t); b.hb = window.setInterval(() => b.raw({ type: 'HEARTBEAT' }), 5000); ok(b); }
          else if (m.type === 'ID-TAKEN') { clearTimeout(t); fail('ID-TAKEN'); }
          else if (m.type === 'ERROR') { clearTimeout(t); fail(m.payload?.msg || 'Signalling error'); }
          return;
        }
        b.onmsg(m);
      };
      b.ws.onerror = () => { clearTimeout(t); fail('Could not reach the signalling service. Check the internet connection.'); };
      b.ws.onclose = () => { clearTimeout(t); if (!done) fail('The signalling service closed the connection.'); else b.onlost(); };
    });
  }
  raw(m: unknown) { try { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); } catch { /* closed */ } }
  send(type: string, dst: string, payload: unknown) { this.raw({ type, dst, payload }); }
  close() { clearInterval(this.hb); try { this.ws.onclose = null; this.ws.close(); } catch { /* ignore */ } }
}

/** One direct connection (data channel). Messages are JSON; large ones are split into chunks. */
export class Wire {
  pc: RTCPeerConnection; dc: RTCDataChannel | null = null; open = false;
  onmsg: (m: any) => void = () => undefined; onclose: () => void = () => undefined; onopen: () => void = () => undefined;
  private parts = new Map<string, string[]>(); private pend: RTCIceCandidateInit[] = []; private haveRemote = false; private closed = false;
  constructor(public remote: string, public cid: string) {
    this.pc = new RTCPeerConnection({ iceServers: ICE });
    this.pc.onconnectionstatechange = () => { const s = this.pc.connectionState; if (s === 'failed' || s === 'closed') this.close(); };
  }
  attach(dc: RTCDataChannel) {
    this.dc = dc;
    dc.onopen = () => { this.open = true; this.onopen(); };
    dc.onclose = () => this.close();
    dc.onmessage = (e) => {
      let m: any; try { m = JSON.parse(e.data); } catch { return; }
      if (m && m['~']) {
        const a = this.parts.get(m['~']) ?? new Array(m.n).fill(null); a[m.i] = m.s; this.parts.set(m['~'], a);
        if (a.every((x) => x != null)) { this.parts.delete(m['~']); try { this.onmsg(JSON.parse(a.join(''))); } catch { /* bad */ } }
        return;
      }
      this.onmsg(m);
    };
  }
  send(m: unknown) {
    if (!this.dc || this.dc.readyState !== 'open') return;
    const s = JSON.stringify(m);
    try {
      if (s.length <= CHUNK) { this.dc.send(s); return; }
      const id = rnd(8), n = Math.ceil(s.length / CHUNK);
      for (let i = 0; i < n; i++) this.dc.send(JSON.stringify({ '~': id, i, n, s: s.slice(i * CHUNK, (i + 1) * CHUNK) }));
    } catch { /* channel closing */ }
  }
  async remoteDesc(d: RTCSessionDescriptionInit) { await this.pc.setRemoteDescription(d); this.haveRemote = true; for (const c of this.pend.splice(0)) await this.pc.addIceCandidate(c).catch(() => undefined); }
  async candidate(c: RTCIceCandidateInit) { if (this.haveRemote) await this.pc.addIceCandidate(c).catch(() => undefined); else this.pend.push(c); }
  close() { if (this.closed) return; this.closed = true; this.open = false; try { this.dc?.close(); this.pc.close(); } catch { /* ignore */ } this.onclose(); }
}

/** Host: registers the room code with the broker and accepts guests. */
export class HostNet {
  wires = new Map<string, Wire>();
  onjoin: (id: string) => void = () => undefined; onleave: (id: string) => void = () => undefined; onmsg: (id: string, m: any) => void = () => undefined;
  constructor(public code: string, private b: Broker) {
    b.onmsg = (m) => void this.signal(m);
  }
  static async create(): Promise<HostNet> {
    for (let i = 0; i < 4; i++) {
      const code = newCode();
      try { return new HostNet(code, await Broker.open(PREFIX + code)); } catch (e: any) { if (e.message !== 'ID-TAKEN') throw e; }
    }
    throw new Error('Could not get a free room code. Try again.');
  }
  private async signal(m: any) {
    const src = String(m.src ?? ''), p = m.payload ?? {};
    if (m.type === 'OFFER') {
      if (this.wires.size >= 7) return; // a room holds the host and up to 7 guests
      const w = new Wire(src, p.cid); this.wires.get(src)?.close(); this.wires.set(src, w);
      w.pc.onicecandidate = (e) => { if (e.candidate) this.b.send('CANDIDATE', src, { cid: w.cid, c: e.candidate.toJSON() }); };
      w.pc.ondatachannel = (e) => w.attach(e.channel);
      w.onopen = () => this.onjoin(src);
      w.onmsg = (x) => this.onmsg(src, x);
      w.onclose = () => { if (this.wires.get(src) === w) { this.wires.delete(src); this.onleave(src); } };
      try { await w.remoteDesc(p.sdp); const a = await w.pc.createAnswer(); await w.pc.setLocalDescription(a); this.b.send('ANSWER', src, { cid: w.cid, sdp: w.pc.localDescription }); } catch { w.close(); }
    } else if (m.type === 'CANDIDATE') { const w = this.wires.get(src); if (w && w.cid === p.cid) await w.candidate(p.c); }
    else if (m.type === 'LEAVE') this.wires.get(src)?.close();
  }
  send(id: string, m: unknown) { this.wires.get(id)?.send(m); }
  broadcast(m: unknown) { for (const w of this.wires.values()) w.send(m); }
  close() { this.b.close(); for (const w of [...this.wires.values()]) w.close(); this.wires.clear(); }
}

/** Guest: connects to the host of a room code. Resolves once the data channel is open. */
export async function joinNet(code: string): Promise<Wire> {
  const me = PREFIX + 'g' + rnd(10), host = PREFIX + cleanCode(code);
  const b = await Broker.open(me);
  const w = new Wire(host, rnd(8));
  return new Promise<Wire>((ok, bad) => {
    let done = false;
    const fail = (msg: string) => { if (done) return; done = true; clearTimeout(t); b.close(); w.onclose = () => undefined; w.close(); bad(new Error(msg)); };
    const t = setTimeout(() => fail('Could not connect directly to the host. Both computers need internet access that allows peer-to-peer connections (the same Wi-Fi or a phone hotspot usually works).'), 25000);
    b.onmsg = (m) => {
      const p = m.payload ?? {};
      if (m.type === 'EXPIRE') fail(`No room with the code ${cleanCode(code)}. Check the code, and that the host still has the room open.`);
      else if (m.type === 'ANSWER' && p.cid === w.cid) void w.remoteDesc(p.sdp).catch(() => fail('The host refused the connection.'));
      else if (m.type === 'CANDIDATE' && p.cid === w.cid) void w.candidate(p.c);
    };
    w.pc.onicecandidate = (e) => { if (e.candidate) b.send('CANDIDATE', host, { cid: w.cid, c: e.candidate.toJSON() }); };
    w.attach(w.pc.createDataChannel('room', { ordered: true }));
    w.onopen = () => { if (done) return; done = true; clearTimeout(t); setTimeout(() => b.close(), 3000); ok(w); };
    w.pc.createOffer().then((o) => w.pc.setLocalDescription(o)).then(() => b.send('OFFER', host, { cid: w.cid, sdp: w.pc.localDescription })).catch(() => fail('This browser could not start a peer-to-peer connection.'));
  });
}
