import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type DB = DatabaseSync;
// Loaded via require so bundlers/test runners leave this newer Node built-in alone.
const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const MIGRATIONS: string[] = [
  `CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
     role TEXT NOT NULL CHECK(role IN ('trainee','instructor','commander','admin')), unit TEXT NOT NULL DEFAULT 'Unit',
     pass TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}', disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
   CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE config_versions(id INTEGER PRIMARY KEY, config TEXT NOT NULL, author INTEGER REFERENCES users(id), note TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE drills(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, mode TEXT NOT NULL, template TEXT,
     cfg TEXT NOT NULL, spawns TEXT, actions TEXT NOT NULL, end_tick INTEGER NOT NULL, total INTEGER NOT NULL, client_total INTEGER,
     verified INTEGER NOT NULL, chain TEXT NOT NULL, flags TEXT NOT NULL, record TEXT NOT NULL, config_version INTEGER);
   CREATE INDEX drills_user ON drills(user_id, created_at);
   CREATE TABLE templates(id INTEGER PRIMARY KEY, name TEXT NOT NULL, cfg TEXT NOT NULL, spawns TEXT NOT NULL, author INTEGER REFERENCES users(id), created_at INTEGER NOT NULL);
   CREATE TABLE audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, user_id INTEGER, action TEXT NOT NULL, detail TEXT);`,
  // 2: study cohort for measuring training transfer (adaptive vs fixed-difficulty control group).
  `ALTER TABLE users ADD COLUMN cohort TEXT NOT NULL DEFAULT 'adaptive' CHECK(cohort IN ('adaptive','control'));`,
  // 3: lecture library (video files live in <dataDir>/lectures/<file>).
  `CREATE TABLE lectures(id INTEGER PRIMARY KEY, title TEXT NOT NULL, topic TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', file TEXT NOT NULL, mime TEXT NOT NULL,
     size INTEGER NOT NULL, duration REAL, sha256 TEXT NOT NULL, author INTEGER REFERENCES users(id), created_at INTEGER NOT NULL);`,
];
/** Open (or create) the database and apply any pending migrations. */
export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'parashurama.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);');
  const row = db.prepare("SELECT v FROM meta WHERE k='schema'").get() as { v: string } | undefined;
  let v = row ? +row.v : 0;
  for (; v < MIGRATIONS.length; v++) { db.exec('BEGIN'); db.exec(MIGRATIONS[v]); db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('schema',?)").run(String(v + 1)); db.exec('COMMIT'); }
  return db;
}
export function audit(db: DB, userId: number | null, action: string, detail = '') {
  db.prepare('INSERT INTO audit(at,user_id,action,detail) VALUES(?,?,?,?)').run(Date.now(), userId, action, detail.slice(0, 500));
}
