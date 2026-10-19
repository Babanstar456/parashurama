import type { Config } from './config';
import trustJson from '../../../config/trust/keys.json';

/**
 * Signed threat packs (`*.cuaspack.json`): doctrine/threat updates that reach units offline (USB) and can be checked
 * for tampering. ECDSA P-256 with SHA-256, signature in IEEE P1363 form (r‖s, 64 bytes), as WebCrypto produces it.
 * The signature covers the canonical JSON of { meta, config }. Works in browsers and Node (globalThis.crypto.subtle).
 */
export interface PackMeta { id: string; version: string; issuer: string; date: string; keyId?: string; }
export interface ThreatPack { meta: PackMeta; config: Partial<Pick<Config, 'threats' | 'effectors' | 'doctrine' | 'training'>>; sig: string; }
export interface TrustKey { id: string; issuer: string; jwk: JsonWebKey; }
export type PackResult = { ok: true; keyId: string } | { ok: false; error: string };

/** Public keys of trusted pack issuers, bundled at build time from config/trust/keys.json. Private keys never go in the repo. */
export const TRUST_KEYS: TrustKey[] = (trustJson as { keys: TrustKey[] }).keys;

/** Canonical JSON: object keys sorted recursively, no whitespace. Signer and verifier must agree byte for byte. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
/** The exact bytes that are signed. */
export const packPayload = (p: Pick<ThreatPack, 'meta' | 'config'>): Uint8Array => new TextEncoder().encode(canonical({ meta: p.meta, config: p.config }));

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
const subtle = (): SubtleCrypto => {
  const s = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!s) throw new Error('WebCrypto (crypto.subtle) is not available in this runtime');
  return s;
};

/** Check a pack's shape and signature against the trusted keys. Does NOT validate the config itself; run validateConfig after merging. */
export async function verifyPack(pack: unknown, keys: TrustKey[] = TRUST_KEYS): Promise<PackResult> {
  const p = pack as ThreatPack;
  if (!p || typeof p !== 'object' || !p.meta || !p.config || typeof p.sig !== 'string') return { ok: false, error: 'Not a threat pack: needs meta, config and sig' };
  for (const k of ['id', 'version', 'issuer', 'date'] as const) if (typeof p.meta[k] !== 'string' || !p.meta[k]) return { ok: false, error: `Pack meta.${k} is missing` };
  if (typeof p.config !== 'object' || !Object.keys(p.config).length) return { ok: false, error: 'Pack config is empty' };
  if (Object.keys(p.config).some((k) => !['threats', 'effectors', 'doctrine', 'training'].includes(k))) return { ok: false, error: 'Pack config may only contain threats, effectors, doctrine and training' };
  const cands = keys.filter((k) => (p.meta.keyId ? k.id === p.meta.keyId : true) && k.issuer === p.meta.issuer);
  if (!cands.length) return { ok: false, error: `No trusted key for issuer "${p.meta.issuer}"${p.meta.keyId ? ` (key ${p.meta.keyId})` : ''}` };
  let sig: Uint8Array;
  try { sig = b64(p.sig); } catch { return { ok: false, error: 'Signature is not valid base64' }; }
  const data = packPayload(p);
  for (const k of cands) {
    const { kty, crv, x, y } = k.jwk;
    try {
      const key = await subtle().importKey('jwk', { kty, crv, x, y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig as BufferSource, data as BufferSource)) return { ok: true, keyId: k.id };
    } catch { /* malformed key or signature: try the next key */ }
  }
  return { ok: false, error: 'Signature does not match: the pack was changed or signed by another key' };
}

/** Apply a verified pack on top of a config (whole files are replaced). Validate the result before using it. */
export function applyPack(base: Config, p: ThreatPack): Config {
  return { ...base, ...p.config } as Config;
}
