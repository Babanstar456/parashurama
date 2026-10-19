// Application-level encryption of training records at rest (node:sqlite has no SQLCipher).
// AES-256-GCM, random 12-byte IV, stored as  v1:<iv>:<tag>:<ciphertext>  (base64 parts).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const PREFIX = 'v1:';
export const isSealed = (s: string) => s.startsWith(PREFIX);

export function seal(text: string, key: Buffer | null): string {
  if (!key) return text;
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

/** Decrypt a sealed value. Plaintext rows from before encryption was switched on are returned unchanged. */
export function open(blob: string, key: Buffer | null): string {
  if (!isSealed(blob)) return blob;
  if (!key) throw new Error('This record is encrypted: start the server with PARASHURAMA_DATA_KEY or PARASHURAMA_DATA_KEY_FILE');
  const [iv, tag, ct] = blob.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/**
 * The data key: PARASHURAMA_DATA_KEY (32 bytes, base64) or PARASHURAMA_DATA_KEY_FILE (a file holding that base64,
 * which must be OUTSIDE the data directory so a copied database or backup does not carry its own key).
 */
export function loadDataKey(env: NodeJS.ProcessEnv, dataDir: string): Buffer | null {
  let b64 = env.PARASHURAMA_DATA_KEY;
  if (!b64 && env.PARASHURAMA_DATA_KEY_FILE) {
    const f = resolve(env.PARASHURAMA_DATA_KEY_FILE);
    if (!relative(resolve(dataDir), f).startsWith('..')) throw new Error('PARASHURAMA_DATA_KEY_FILE must be outside the data directory');
    b64 = readFileSync(f, 'utf8').trim();
  }
  if (!b64) return null;
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('The data key must be 32 bytes, base64-encoded (e.g. openssl rand -base64 32)');
  return key;
}
