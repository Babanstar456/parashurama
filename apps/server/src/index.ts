import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { buildApp } from './app';
import { createUser } from './auth';
import { loadDataKey } from './crypto';

process.removeAllListeners('warning');
const env = process.env;
const tls = env.TLS_CERT && env.TLS_KEY ? { cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) } : null;
const dataDir = env.DATA_DIR ?? './data';
const dataKey = loadDataKey(env, dataDir);
if (!dataKey) {
  if (env.NODE_ENV === 'production') { console.error('Refusing to start: set PARASHURAMA_DATA_KEY or PARASHURAMA_DATA_KEY_FILE (32 bytes, base64; e.g. openssl rand -base64 32). See docs/ADMIN_GUIDE.md.'); process.exit(1); }
  console.warn('  Warning: no data key set, so drill records are stored unencrypted. Set PARASHURAMA_DATA_KEY for production.');
}
const { app, db } = await buildApp({ dataKey, dataDir, webDir: env.WEB_DIR ?? '../web/dist', secureCookies: !!tls || env.COOKIE_SECURE === '1', lectureMaxBytes: env.LECTURE_MAX_MB ? +env.LECTURE_MAX_MB * 1048576 : undefined, logger: env.LOG !== '0' });
// First start: create the admin account.
if ((db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n === 0) {
  createUser(db, { username: env.ADMIN_USERNAME ?? 'admin', name: 'Administrator', role: 'admin', unit: env.UNIT_NAME ?? 'Unit' });
  console.log(`\n  First start: created admin account. Sign in as "${env.ADMIN_USERNAME ?? 'admin'}" to manage the unit.\n`);
}
const port = +(env.PORT ?? (tls ? 8443 : 8080)), host = env.HOST ?? '0.0.0.0';
if (tls) {
  await app.ready();
  createServer(tls, (req, res) => app.server.emit('request', req, res)).listen(port, host, () => console.log(`PARASHURAMA unit server on https://${host}:${port}`));
} else {
  await app.listen({ port, host });
  console.log(`PARASHURAMA unit server on http://${host}:${port}`);
}
