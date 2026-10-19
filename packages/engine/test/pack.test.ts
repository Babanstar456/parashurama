import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { applyPack, canonical, defaultConfig, packPayload, validateConfig, verifyPack, type ThreatPack, type TrustKey } from '../src';

/** Test-only signer (same as scripts/sign-pack.ts): ECDSA P-256, SHA-256, IEEE P1363 signature. */
function issuer(id: string, name = 'DSSC') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  const trust: TrustKey = { id, issuer: name, jwk: { kty, crv, x, y } };
  const signPack = (meta: ThreatPack['meta'], config: ThreatPack['config']): ThreatPack =>
    ({ meta, config, sig: sign('sha256', packPayload({ meta, config }), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') });
  return { trust, signPack };
}
const meta = { id: 'pack-2026-11', version: '1.2.0', issuer: 'DSSC', date: '2026-11-01' };
const newThreats = () => { const t = JSON.parse(JSON.stringify(defaultConfig.threats)); t.version = '1.3.0'; t.threats.fpv.speed = 35; return t; };

describe('signed threat packs (item 9)', () => {
  it('canonical JSON ignores key order and whitespace', () => {
    expect(canonical({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: 'z' } })).toBe('{"a":{"c":"z","d":[2,{"x":0,"y":1}]},"b":1}');
  });

  it('accepts a valid pack from a trusted key, and the merged config validates', async () => {
    const A = issuer('dssc-1');
    const pack = A.signPack(meta, { threats: newThreats() });
    expect(await verifyPack(JSON.parse(JSON.stringify(pack)), [A.trust])).toEqual({ ok: true, keyId: 'dssc-1' });
    const merged = applyPack(defaultConfig, pack);
    expect(validateConfig(merged).ok).toBe(true);
    expect(merged.threats.threats.fpv.speed).toBe(35);
    expect(merged.effectors).toBe(defaultConfig.effectors);
  });

  it('rejects a pack with one changed value', async () => {
    const A = issuer('dssc-1');
    const pack = A.signPack(meta, { threats: newThreats() });
    const bad = JSON.parse(JSON.stringify(pack)); bad.config.threats.threats.fpv.speed = 36;
    expect((await verifyPack(bad, [A.trust])).ok).toBe(false);
    const badMeta = JSON.parse(JSON.stringify(pack)); badMeta.meta.version = '9.9.9';
    expect((await verifyPack(badMeta, [A.trust])).ok).toBe(false);
  });

  it('rejects unknown issuers and packs signed by an untrusted key', async () => {
    const A = issuer('dssc-1'), M = issuer('mallory-1');
    const pack = M.signPack(meta, { threats: newThreats() });
    const r = await verifyPack(pack, [A.trust]);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Signature does not match/) });
    expect(await verifyPack(A.signPack({ ...meta, issuer: 'Nobody' }, { threats: newThreats() }), [A.trust])).toMatchObject({ ok: false, error: expect.stringMatching(/No trusted key/) });
    expect(await verifyPack(pack, [])).toMatchObject({ ok: false });
  });

  it('a valid signature on an invalid config is caught by validateConfig', async () => {
    const A = issuer('dssc-1');
    const t = newThreats(); t.threats.fpv.alt = [60, 15];
    const pack = A.signPack(meta, { threats: t });
    expect((await verifyPack(pack, [A.trust])).ok).toBe(true);
    const r = validateConfig(applyPack(defaultConfig, pack));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/alt min > max/);
  });

  it('rejects malformed packs with a readable reason', async () => {
    expect(await verifyPack({ config: {}, sig: 'x' })).toMatchObject({ ok: false, error: expect.stringMatching(/meta/) });
    expect(await verifyPack({ meta, config: { users: [] }, sig: 'AA==' })).toMatchObject({ ok: false, error: expect.stringMatching(/may only contain/) });
  });
});
