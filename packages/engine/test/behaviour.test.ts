import { describe, expect, it } from 'vitest';
import { action, condition, describeTree, runSim, selector, sequence, THREAT_TREE, type BTNode } from '../src';
import { C, baseCfg } from './helpers';

const ev = (k: string, v: unknown) => console.log(`EVIDENCE ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

describe('behaviour tree nodes', () => {
  const log: string[] = [];
  const ok = (n: string): BTNode<null> => action(n, () => { log.push(n); });
  const no = (n: string): BTNode<null> => condition(n, () => { log.push(n); return false; });
  const wait = (n: string): BTNode<null> => action(n, () => { log.push(n); return 'running'; });

  it('a selector runs its children until one does not fail', () => {
    log.length = 0;
    expect(selector('s', no('a'), ok('b'), ok('c')).tick(null)).toBe('success');
    expect(log).toEqual(['a', 'b']);
    log.length = 0;
    expect(selector('s', no('a'), no('b')).tick(null)).toBe('failure');
    expect(log).toEqual(['a', 'b']);
  });
  it('a sequence runs its children until one does not succeed', () => {
    log.length = 0;
    expect(sequence('q', ok('a'), no('b'), ok('c')).tick(null)).toBe('failure');
    expect(log).toEqual(['a', 'b']);
    log.length = 0;
    expect(sequence('q', ok('a'), ok('b')).tick(null)).toBe('success');
  });
  it('running stops both kinds and is passed up', () => {
    log.length = 0;
    expect(sequence('q', ok('a'), wait('b'), ok('c')).tick(null)).toBe('running');
    expect(selector('s', wait('x'), ok('y')).tick(null)).toBe('running');
    expect(log).toEqual(['a', 'b', 'x']);
  });
});

describe('threat behaviour tree', () => {
  it('has one branch per kind of drone behaviour', () => {
    const text = describeTree(THREAT_TREE);
    for (const b of ['wander', 'patrol orbit', 'surveillance on station', 'hover at stand-off', 'attack run', 'cohesion and separation', 'weave']) expect(text).toContain(b);
    const count = (n: BTNode<unknown>): number => 1 + (n.children ?? []).reduce((s, k) => s + count(k), 0);
    ev('threat behaviour tree', `${count(THREAT_TREE)} nodes, ${THREAT_TREE.children!.length} top-level behaviours`);
  });

  // One drone of each type, 3 km out, nobody defending: each must do what its branch says.
  const fly = (type: string) => {
    const E = runSim(baseCfg({ seed: 99, pattern: 'mixed' }), { until: 3000, spawns: [{ type, t: 1, brg: 45, dist: 3000 }] });
    return E.contacts.find((c) => c.type === type)!;
  };
  const byMotion = (m: string) => Object.entries(C.threats.threats).filter(([, t]) => t.motion === m).map(([k]) => k);

  it('attack runs (straight, weaving and swarm drones) reach the asset when nobody engages them', () => {
    for (const k of [...byMotion('straight'), ...byMotion('weave'), ...byMotion('swarm')]) expect(fly(k).state, k).toBe('leaked');
  });
  it('recon drones stop and hover at stand-off instead of attacking', () => {
    for (const k of byMotion('approachHover')) { const c = fly(k); expect(c.hover, k).toBe(true); expect(c.state, k).toBe('live'); }
  });
  it('surveillance UAVs take station and circle at stand-off range', () => {
    for (const k of byMotion('surveil')) {
      const c = fly(k);
      expect(c.orbit && c.hover, k).toBe(true);
      expect(Math.abs(Math.hypot(c.x, c.y) - c.orad), k).toBeLessThan(1);
    }
  });
  it('birds and civil traffic wander and never reach the asset', () => {
    for (const k of byMotion('wander')) expect(fly(k).state, k).not.toBe('leaked');
  });
});
