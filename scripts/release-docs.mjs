// Publish the app to docs/ (served by Vercel, root docs/):
//   docs/                  the full build (app, 3D models, skies, textures, sounds): the main link, what the demo shows
//   docs/offline/          the single-file copy for units with no server (one HTML file; the 3D drill uses plain shapes)
// Files from the previous release are removed first (docs/.release-files), and docs/RELEASE.txt records a fingerprint of
// every file, so anyone can check that the live site is exactly this build:  node scripts/release-docs.mjs --check <dir>
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const FULL = 'apps/web/dist', SINGLE = 'apps/web/dist-single/index.html', OUT = 'docs', LIST = join(OUT, '.release-files');
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
/** One fingerprint for a whole build: SHA-256 over the sorted list of "path sha256" lines. */
const fingerprint = (root) => {
  const lines = walk(root).map((p) => relative(root, p).split('\\').join('/')).filter((r) => !['RELEASE.txt', '.release-files'].includes(r) && !r.endsWith('.md') && !['comparison.html', 'threat-library.html', 'sbom.cdx.json'].includes(r))
    .sort().map((r) => `${r} ${sha(join(root, r))}`);
  return { files: lines.length, digest: createHash('sha256').update(lines.join('\n')).digest('hex') };
};

if (process.argv[2] === '--check') {
  // Compare a downloaded copy of the site (or the docs/ folder) with docs/RELEASE.txt.
  const dir = process.argv[3] ?? OUT, want = /full build fingerprint: ([0-9a-f]+)/.exec(readFileSync(join(OUT, 'RELEASE.txt'), 'utf8'))?.[1];
  const got = fingerprint(dir).digest;
  console.log(got === want ? `OK: ${dir} matches the release (${got})` : `MISMATCH: ${dir} is ${got}, release says ${want}`);
  process.exit(got === want ? 0 : 1);
}
if (!existsSync(join(FULL, 'index.html')) || !existsSync(SINGLE)) throw new Error('Build first: npm run build -w @parashurama/web && npm run build:single');

// 1. Remove the previous release's files (never the guides, the comparison pages or the SBOM).
if (existsSync(LIST)) for (const r of readFileSync(LIST, 'utf8').split('\n').filter(Boolean)) rmSync(join(OUT, r), { force: true });
for (const d of ['assets', 'models', 'audio', 'offline']) if (existsSync(join(OUT, d))) rmSync(join(OUT, d), { recursive: true, force: true });

// 2. The full build is the main site.
const full = walk(FULL).map((p) => relative(FULL, p).split('\\').join('/'));
for (const r of full) { mkdirSync(dirname(join(OUT, r)), { recursive: true }); cpSync(join(FULL, r), join(OUT, r)); }

// 3. The single-file copy, for offline use (no manifest or icon links: it runs from file:// too).
const drop = ['<link rel="manifest" href="manifest.webmanifest">', '<link rel="icon" href="icon-192.png">'];
const single = readFileSync(SINGLE, 'utf8').split('\n').filter((l) => !drop.includes(l.trim())).join('\n');
mkdirSync(join(OUT, 'offline'), { recursive: true }); writeFileSync(join(OUT, 'offline', 'index.html'), single);
writeFileSync(LIST, [...full, 'offline/index.html'].join('\n') + '\n');

// 4. Fingerprints.
const fp = fingerprint(OUT), bytes = full.reduce((a, r) => a + statSync(join(OUT, r)).size, 0) + Buffer.byteLength(single);
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const when = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
writeFileSync(join(OUT, 'RELEASE.txt'), `PARASHURAMA ${version}, released ${when}

Main site (the full build: app, 3D models, skies, textures, sounds)
  files: ${fp.files}, ${(bytes / 1e6).toFixed(1)} MB
  index.html sha256: ${sha(join(OUT, 'index.html'))}
  full build fingerprint: ${fp.digest}
  Check a copy of the site:  node scripts/release-docs.mjs --check <folder>

Offline single-file copy (offline/index.html; the 3D drill uses plain shapes and generated sound)
  sha256: ${sha(join(OUT, 'offline', 'index.html'))}
  Check a copy:  sha256sum index.html   (Windows: certutil -hashfile index.html SHA256)
`);
console.log(`docs/: ${fp.files} files, ${(bytes / 1e6).toFixed(1)} MB, fingerprint ${fp.digest}`);
