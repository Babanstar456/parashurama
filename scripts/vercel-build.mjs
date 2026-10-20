// Vercel build: the web app from source (installable, works offline after the first visit through its service worker),
// plus the static pages from docs/ and the one-file offline copy. Output: vercel-out/  (see vercel.json)
// The unit server (Fastify + SQLite, LAN crew drills) is not deployed here: it needs a long-running process and a disk.
// On Vercel the app runs in its offline mode: history in the browser, no sign-in, no crew drills.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const out = 'vercel-out';
execSync('npm run build -w @parashurama/web', { stdio: 'inherit' });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync('apps/web/dist', out, { recursive: true });
// Static pages and the downloadable one-file app (checked against docs/RELEASE.txt).
for (const f of ['comparison.html', 'threat-library.html', 'RELEASE.txt']) if (existsSync(`docs/${f}`)) cpSync(`docs/${f}`, `${out}/${f}`);
if (existsSync('docs/index.html')) cpSync('docs/index.html', `${out}/offline.html`);
// Printable guides as plain text.
mkdirSync(`${out}/guides`, { recursive: true });
for (const f of ['TRAINEE_GUIDE.md', 'INSTRUCTOR_GUIDE.md', 'FIELD_GUIDE.md', 'GUN_FIELD_CARD.md', 'TRACEABILITY.md']) if (existsSync(`docs/${f}`)) cpSync(`docs/${f}`, `${out}/guides/${f}`);
console.log(`✓ Vercel output in ${out}/`);
