// Create an ECDSA P-256 key pair for signing threat packs.
//   npm run pack:keygen -- <issuer> <key-id> <private-key-path>
// The private key is written OUTSIDE the repository (refused otherwise); the public key is added to config/trust/keys.json.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const [issuer, id, out] = process.argv.slice(2);
if (!issuer || !id || !out) { console.error('Usage: pack:keygen <issuer> <key-id> <private-key-path-outside-repo>'); process.exit(1); }
const repo = resolve(import.meta.dirname, '../../..'), target = resolve(out);
if (!relative(repo, target).startsWith('..')) { console.error('Refusing: the private key must be stored outside the repository.'); process.exit(1); }
if (existsSync(target)) { console.error(`Refusing to overwrite ${target}`); process.exit(1); }
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
writeFileSync(target, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const jwk = publicKey.export({ format: 'jwk' });
const file = resolve(repo, 'config/trust/keys.json'), trust = JSON.parse(readFileSync(file, 'utf8'));
if (trust.keys.some((k: { id: string }) => k.id === id)) { console.error(`Key id "${id}" already exists`); process.exit(1); }
trust.keys.push({ id, issuer, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } });
writeFileSync(file, JSON.stringify(trust, null, 2) + '\n');
console.log(`Private key: ${target} (keep it offline)\nPublic key "${id}" for ${issuer} added to config/trust/keys.json; rebuild the app to trust it.`);
