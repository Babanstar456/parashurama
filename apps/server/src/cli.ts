// Admin command line: add users and take backups without the web UI.
//   npm run user:add -w @parashurama/server -- <username> "<Full name>" <role> [unit]
//   npm run backup   -w @parashurama/server
//   npm run migrate:encrypt -w @parashurama/server   (with PARASHURAMA_DATA_KEY or PARASHURAMA_DATA_KEY_FILE set)
import { openDb } from './db';
import { createUser, type Role } from './auth';
import { backup, encryptExisting } from './app';
import { loadDataKey } from './crypto';

process.removeAllListeners('warning');
const [cmd, ...a] = process.argv.slice(2);
const dataDir = process.env.DATA_DIR ?? './data';
const db = openDb(dataDir);
if (cmd === 'user:add') {
  const [username, name, role, unit] = a;
  if (!username || !name || !['trainee', 'instructor', 'commander', 'admin'].includes(role)) {
    console.error('Usage: user:add <username> "<Full name>" <trainee|instructor|commander|admin> [unit]'); process.exit(1);
  }
  console.log(`Created user #${createUser(db, { username: username.toLowerCase(), name, role: role as Role, unit })} ${username} (${role})`);
} else if (cmd === 'backup') console.log('Backup written:', backup(db, dataDir));
else if (cmd === 'migrate-encrypt') {
  const key = loadDataKey(process.env, dataDir);
  if (!key) { console.error('Set PARASHURAMA_DATA_KEY or PARASHURAMA_DATA_KEY_FILE first.'); process.exit(1); }
  console.log('Backup before migration:', backup(db, dataDir));
  console.log(`Encrypted ${encryptExisting(db, key)} drill record(s).`);
} else { console.error('Commands: user:add, backup, migrate-encrypt'); process.exit(1); }
