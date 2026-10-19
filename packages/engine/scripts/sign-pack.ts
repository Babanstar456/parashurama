// Sign a threat pack.  npm run pack:sign -- <unsigned.json> <private-key.pem> [out.cuaspack.json]
// <unsigned.json> = { "meta": { id, version, issuer, date, keyId? }, "config": { threats?, effectors?, doctrine?, training? } }
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { packPayload } from '../src/pack';

const [inp, keyPath, out] = process.argv.slice(2);
if (!inp || !keyPath) { console.error('Usage: pack:sign <unsigned.json> <private-key.pem> [out.cuaspack.json]'); process.exit(1); }
const { meta, config } = JSON.parse(readFileSync(inp, 'utf8'));
const key = createPrivateKey(readFileSync(keyPath));
// IEEE P1363 (r‖s) is the signature format WebCrypto verifies.
const sig = sign('sha256', packPayload({ meta, config }), { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
const dest = out ?? inp.replace(/\.json$/, '') + '.cuaspack.json';
writeFileSync(dest, JSON.stringify({ meta, config, sig }, null, 2) + '\n');
console.log(`Signed ${meta.id} v${meta.version} → ${dest}`);
