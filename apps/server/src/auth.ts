import { createHash, randomBytes } from 'node:crypto';
import type { DB } from './db';

export type Role = 'trainee' | 'instructor' | 'commander' | 'admin';
export interface User { id: number; username: string; name: string; role: Role; unit: string; settings: any; }
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
export const SESSION_HOURS = 12;
export function createSession(db: DB, userId: number): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(sha(token), userId, Date.now() + SESSION_HOURS * 3600e3, Date.now());
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return token;
}
export function userForToken(db: DB, token: string | undefined): User | null {
  if (!token) return null;
  const r = db.prepare(`SELECT u.id,u.username,u.name,u.role,u.unit,u.settings FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0`).get(sha(token), Date.now()) as any;
  return r ? { ...r, settings: JSON.parse(r.settings || '{}') } : null;
}
export function dropSession(db: DB, token: string | undefined) { if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token)); }
/** Sign-in is by name only: turn a typed name into the account's username ("Nk Rao" -> "nk.rao"). */
export function usernameFor(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').slice(0, 40);
}
export function createUser(db: DB, u: { username: string; name: string; role: Role; unit?: string }): number {
  // `pass` is kept empty: accounts have no passwords.
  const r = db.prepare('INSERT INTO users(username,name,role,unit,pass,created_at) VALUES(?,?,?,?,?,?)').run(u.username, u.name, u.role, u.unit ?? 'Unit', '', Date.now());
  return Number(r.lastInsertRowid);
}
/** Simple fixed-window limiter (per key). */
export class Limiter {
  private hits = new Map<string, { n: number; t: number }>();
  constructor(private max: number, private windowMs: number) {}
  hit(key: string): boolean {
    const now = Date.now(), h = this.hits.get(key);
    if (!h || now - h.t > this.windowMs) { this.hits.set(key, { n: 1, t: now }); return true; }
    h.n++; return h.n <= this.max;
  }
  reset(key: string) { this.hits.delete(key); }
}
