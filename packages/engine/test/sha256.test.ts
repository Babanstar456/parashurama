import { describe, expect, it } from 'vitest';
import { chainHash, mulberry, sha256Js, type Action } from '../src';

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('SHA-256 without WebCrypto (LAN players over plain http)', () => {
  it('matches the standard test vector', () => {
    expect(hex(sha256Js(new TextEncoder().encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha256Js(new Uint8Array(0)))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('matches WebCrypto for every length up to 300 bytes (all padding edges)', async () => {
    const r = mulberry(7);
    for (let n = 0; n <= 300; n++) {
      const m = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
      expect(hex(sha256Js(m)), `length ${n}`).toBe(hex(await crypto.subtle.digest('SHA-256', m)));
    }
  });
  it('gives the same decision-log chain with and without WebCrypto', async () => {
    const log: Action[] = Array.from({ length: 40 }, (_, i) => ({ tick: 10 + i * 7, k: (['track', 'id', 'eng'] as const)[i % 3], cid: 1 + (i % 5), cls: 'fpv', conf: 0.8, eff: 'jam' }));
    const withSubtle = await chainHash(log);
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    try { expect(await chainHash(log)).toBe(withSubtle); }
    finally { if (saved) Object.defineProperty(globalThis, 'crypto', saved); }
  });
});
