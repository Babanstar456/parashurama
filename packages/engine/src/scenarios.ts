import scenariosJson from '../../../config/scenarios.json';
import type { DrillConfig, Spawn } from './types';

/** A ready-made, real-world-inspired drill: fixed conditions and a scripted raid. */
export interface Scenario {
  id: string; name: string; agency: string; context: string; lesson: string;
  cfg: Pick<DrillConfig, 'time' | 'terrain' | 'fault' | 'pattern' | 'weather' | 'roe'>; spawns: Spawn[];
}
export const SCENARIOS: Scenario[] = (scenariosJson as unknown as { scenarios: Scenario[] }).scenarios;

/** Full drill config for a scenario. The seed comes from the id, so the same scenario always plays the same way. */
export function scenarioCfg(s: Scenario, drill: number): DrillConfig {
  const seed = [...s.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 11);
  return { seed, drill, difficulty: 3, faultSector: 0, focus: { sector: null, loiter: false, decoy: false }, ...s.cfg };
}
