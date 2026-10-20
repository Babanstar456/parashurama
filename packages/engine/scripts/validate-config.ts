/**
 * Validate the unit's config files before a release or after an instructor edits them.
 *   npm run validate:config            → checks ./config
 *   npm run validate:config -- path/   → checks another folder (e.g. a new threat pack)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from '../src/config';
import { validateConfig } from '../src/validate';

const dir = resolve(process.argv[2] ?? join(import.meta.dirname, '../../../config'));
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
let cfg: Config;
try {
  cfg = { threats: load('threats.json'), effectors: load('effectors.json'), doctrine: load('doctrine.json'), training: load('training.json'), ...(existsSync(join(dir, 'guns.json')) ? { guns: load('guns.json') } : {}) };
} catch (e) {
  console.error(`✗ Could not read config in ${dir}: ${(e as Error).message}`);
  process.exit(1);
}
const r = validateConfig(cfg);
if (r.ok) {
  console.log(`✓ Config valid (${dir})`);
  console.log(`  threats ${cfg.threats.version} · ${Object.keys(cfg.threats.threats).length} types | effectors ${cfg.effectors.version} · ${cfg.effectors.order.length} | doctrine ${cfg.doctrine.version} | training ${cfg.training.version}${cfg.guns ? ` | guns ${cfg.guns.version} · ${Object.keys(cfg.guns.guns).length}` : ''}`);
} else {
  console.error(`✗ Config invalid (${dir}):`);
  for (const e of r.errors) console.error('  - ' + e);
  process.exit(1);
}
