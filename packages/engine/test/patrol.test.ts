import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPatrol, defaultPatrolCfg, hullBlocked, patrolAI, runPatrol, scorePatrol, segBlocked, stepPatrol, type PatrolAction, type PatrolEngine, type PatrolWorld } from '../src';

// The baked city snippet (apps/web/public/city, tools/city/bake-city.mjs) is the drill's world.
const W: PatrolWorld = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../apps/web/public/city/city.json'), 'utf8')).world;
const play = (seed: number, o: Partial<ReturnType<typeof defaultPatrolCfg>> = {}, policy: (E: PatrolEngine) => PatrolAction[] = patrolAI) => {
  const log: PatrolAction[] = [];
  const E = runPatrol(defaultPatrolCfg({ seed, ...o }), W, { policy: (x) => { const a = policy(x); log.push(...a.map((y) => ({ ...y, tick: x.tick }))); return a; } });
  return { E, log };
};

describe('Urban patrol drill (ZSU-23-4 on the move)', () => {
  it('builds a route on the roads, with the vehicle clear of obstacles at the start', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const E = createPatrol(defaultPatrolCfg({ seed }), W);
      expect(E.cps.length).toBeGreaterThan(0);
      expect(hullBlocked(E, E.veh.x, E.veh.y, E.veh.hdg)).toBeNull();
      expect(E.spawns.some((s) => s.type === 'civil')).toBe(true);
    }
  });
  it('buildings block lines of sight and rounds', () => {
    const E = createPatrol(defaultPatrolCfg(), W), b = W.boxes[0], c: [number, number] = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    expect(segBlocked(E, [c[0] - 60, c[1], 2], [c[0] + 60, c[1], 2])).not.toBeNull();
    expect(segBlocked(E, [c[0] - 60, c[1], 200], [c[0] + 60, c[1], 200])).toBeNull();
  });
  it('drives into a wall: the hull stops and the collision is recorded', () => {
    const E = createPatrol(defaultPatrolCfg({ seed: 2 }), W);
    for (let i = 0; i < 600; i++) stepPatrol(E, i === 0 ? [{ tick: 0, k: 'drive', thr: 1, str: 0.15 }] : []);
    expect(E.collisions.length).toBeGreaterThan(0);
    expect(hullBlocked(E, E.veh.x, E.veh.y, E.veh.hdg)).not.toBe('building');
  });
  it('the expert commander drives the route and defends the patrol', () => {
    const totals: number[] = [];
    let kills = 0, hostiles = 0, dist = 0, cps = 0, cpAll = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const { E } = play(seed), s = scorePatrol(E);
      totals.push(s.total); kills += s.metrics.kills; hostiles += s.metrics.hostiles; dist += s.metrics.distanceM; cps += E.cpDone.length; cpAll += E.cps.length;
      // Never fires on what it has not identified hostile, and never on a non-hostile.
      expect(s.rules).not.toContain('P4');
      expect(s.rules).not.toContain('P6');
    }
    const mean = totals.reduce((a, b) => a + b) / totals.length;
    console.log(`EVIDENCE urban patrol drill, expert over 8 drills: mean ${mean.toFixed(1)} (min ${Math.min(...totals)}), ${kills}/${hostiles} hostiles destroyed, ${cps}/${cpAll} checkpoints, ${Math.round(dist / 8)} m driven per drill`);
    expect(mean).toBeGreaterThanOrEqual(75);
  });
  it('is deterministic: the log replays to the same result', () => {
    const { E, log } = play(5);
    const R = runPatrol(E.cfg, W, { actions: log, stopWhenDone: false }, undefined);
    while (R.tick < E.tick) stepPatrol(R, []);
    expect(R.veh).toEqual(E.veh);
    expect(scorePatrol(R).total).toBe(scorePatrol(E).total);
  });
  it('P6 and P4: firing on a contact not identified hostile, or on a civil drone, costs points', () => {
    const E = createPatrol(defaultPatrolCfg({ seed: 3 }), W);
    let civ: PatrolEngine['targets'][number] | undefined;
    while (E.tick < 3000 && !(civ = E.targets.find((t) => t.type === 'civil' && t.state === 'live' && E.seen[t.id] != null))) stepPatrol(E, []);
    expect(civ).toBeDefined();
    stepPatrol(E, [{ tick: E.tick, k: 'lock', cid: civ!.id }]);
    for (let i = 0; i < 90; i++) stepPatrol(E, i === 70 ? [{ tick: E.tick, k: 'trig', on: true }] : []);
    const s = scorePatrol(E);
    expect(s.rules).toContain('P6');
    expect(s.rules).toContain('P4');
  });
});
