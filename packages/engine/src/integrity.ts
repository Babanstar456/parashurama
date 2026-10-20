import type { GunAction } from './gun';
import type { Action, Engine } from './types';

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** SHA-256 hash chain over the decision log: each decision is linked to the one before, so edits are detectable. */
export async function chainHash(acts: Action[]): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto (crypto.subtle) is not available in this runtime');
  let h = '0'.repeat(64);
  const enc = new TextEncoder();
  for (const a of acts) {
    const data = enc.encode(h + JSON.stringify([a.tick, a.k, a.cid, a.cls ?? '', a.conf ?? '', a.eff ?? '']));
    h = hex(await subtle.digest('SHA-256', data));
  }
  return h;
}

/** SHA-256 hash chain over a gun drill's log (both seats). Separate from chainHash so radar drill hashes never change. */
export async function chainHashGun(acts: GunAction[]): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto (crypto.subtle) is not available in this runtime');
  let h = '0'.repeat(64);
  const enc = new TextEncoder();
  for (const a of acts) {
    const row = [a.tick, a.seat, a.k, a.o ?? '', a.cid ?? '', a.on ?? '', a.az ?? '', a.el ?? '', a.spd ?? '', a.crs ?? '', a.rng ?? '', a.n ?? '', a.out ?? '', a.item ?? '', a.i ?? ''];
    h = hex(await subtle.digest('SHA-256', enc.encode(h + JSON.stringify(row))));
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
