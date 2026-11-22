import type { GunAction } from './gun';
import type { Action, Engine } from './types';

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// SHA-256 in plain JavaScript (FIPS 180-4), for pages the browser does not treat as secure: a player opening the unit
// server over plain http:// on the network gets no crypto.subtle. Same output as WebCrypto (checked in integrity.test.ts).
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export function sha256Js(msg: Uint8Array): ArrayBuffer {
  const len = msg.length, n = ((len + 9 + 63) >> 6) << 6, b = new Uint8Array(n);
  b.set(msg); b[len] = 0x80;
  const dv = new DataView(b.buffer); dv.setUint32(n - 8, Math.floor((len * 8) / 2 ** 32)); dv.setUint32(n - 4, (len * 8) >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), W = new Uint32Array(64);
  const ror = (x: number, k: number) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ror(W[i - 15], 7) ^ ror(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = ror(W[i - 2], 17) ^ ror(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, bb, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) >>> 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new DataView(new ArrayBuffer(32)); H.forEach((v, i) => out.setUint32(i * 4, v)); return out.buffer;
}
/** SHA-256: WebCrypto when the page has it, otherwise the plain-JavaScript version (identical result). */
const digest = async (subtle: SubtleCrypto | undefined, data: Uint8Array): Promise<ArrayBuffer> => (subtle ? subtle.digest('SHA-256', data as BufferSource) : sha256Js(data));

/** SHA-256 hash chain over the decision log: each decision is linked to the one before, so edits are detectable. */
export async function chainHash(acts: Action[]): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  let h = '0'.repeat(64);
  const enc = new TextEncoder();
  for (const a of acts) {
    const data = enc.encode(h + JSON.stringify([a.tick, a.k, a.cid, a.cls ?? '', a.conf ?? '', a.eff ?? '']));
    h = hex(await digest(subtle, data));
  }
  return h;
}

/** SHA-256 hash chain over a gun drill's log (both seats). Separate from chainHash so radar drill hashes never change. */
export async function chainHashGun(acts: GunAction[]): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  let h = '0'.repeat(64);
  const enc = new TextEncoder();
  for (const a of acts) {
    const row = [a.tick, a.seat, a.k, a.o ?? '', a.cid ?? '', a.on ?? '', a.az ?? '', a.el ?? '', a.spd ?? '', a.crs ?? '', a.rng ?? '', a.n ?? '', a.out ?? '', a.item ?? '', a.i ?? ''];
    h = hex(await digest(subtle, enc.encode(h + JSON.stringify(row))));
  }
  return h;
}

/** Fast fingerprint of the whole world state, used to prove two runs are identical. */
export function stateHash(E: Engine): string {
  const s = JSON.stringify([E.tick, E.next, E.stock, E.contacts.map((c) => [c.id, c.type, c.state, c.x.toFixed(4), c.y.toFixed(4), c.trackTick, c.idTick, c.idCls, c.effectAt, c.endTick, c.engs.length])]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
