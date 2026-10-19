import { getConfig, type Config } from './config';
import type { DrillConfig, Spawn } from './types';
import { mulberry } from './util';

/** Deterministic drill generator: the same DrillConfig always yields the same raid. */
export function buildScenario(cfg: DrillConfig, C: Config = getConfig()): Spawn[] {
  const r = mulberry(cfg.seed);
  const S = C.training.scenario;
  const out: Spawn[] = [];
  const add = (type: string, t: number, brg: number) => out.push({ type, t, brg: ((brg % 360) + 360) % 360 });
  const focus = cfg.focus ?? { sector: null, loiter: false, decoy: false };
  const pickBrg = () => (focus.sector != null && r() < 0.45 ? focus.sector + (r() - 0.5) * 40 : r() * 360);
  const d = cfg.difficulty;
  const pool = S.hostilePool;
  const n = 2 + Math.round(d * 0.8);
  let t = 4 + r() * 3;
  for (let i = 0; i < n; i++) {
    let ty = pool[Math.floor(r() * pool.length)];
    if (focus.loiter && i < 2) ty = S.focusType;
    add(ty, t, pickBrg());
    t += 6 + r() * (16 - d);
  }
  add(S.friendlyType, 3 + r() * 14, r() * 360);
  if (focus.decoy) add(S.friendlyType, 30 + r() * 20, r() * 360);
  const nb = 1 + Math.round(d / 2) + (focus.decoy ? 1 : 0);
  for (let i = 0; i < nb; i++) add(S.clutterType, r() * 45, r() * 360);
  if (cfg.pattern === 'swarm') {
    const b = pickBrg(), ts = 20 + r() * 14, k = 3 + Math.min(4, d);
    for (let i = 0; i < k; i++) add(S.swarmType, ts + i * 0.35, b + (r() - 0.5) * 12);
  }
  // Drawn last, and only when configured, so drills from configs without civilType are unchanged.
  if (S.civilType && cfg.terrain === 'urban') add(S.civilType, r() * 40, r() * 360);
  return out.sort((a, b) => a.t - b.t);
}
