// Publish the single-file app to docs/ (served by Vercel/GitHub Pages) and record its SHA-256,
// so a unit can check that its offline copy is genuine:  sha256sum index.html  vs  docs/RELEASE.txt
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const src = 'apps/web/dist-single/index.html', out = 'docs/index.html';
// The docs copy runs from file:// or a static host, so it drops the PWA manifest and icon links.
const drop = ['<link rel="manifest" href="manifest.webmanifest">', '<link rel="icon" href="icon-192.png">'];
const html = readFileSync(src, 'utf8').split('\n').filter((l) => !drop.includes(l.trim())).join('\n');
writeFileSync(out, html);
const sha = createHash('sha256').update(readFileSync(out)).digest('hex');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync('docs/RELEASE.txt', `PARASHURAMA ${version}\nfile: index.html\nbytes: ${Buffer.byteLength(html)}\nsha256: ${sha}\n\nCheck a copy:  sha256sum index.html   (Windows: certutil -hashfile index.html SHA256)\n`);
console.log(`docs/index.html  sha256 ${sha}`);
