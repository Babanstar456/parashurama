// The threat library: every type can be detected, identified and defeated, and each new behaviour does what its card says.
import { describe, expect, it } from 'vitest';
import { decisionClass, expertPolicy, isDone, runTotal, scoreRun, step, ticks, tti } from '../src';
import { C, drive, single } from './helpers';

const T = C.threats.threats;
const pass = C.training.certification.passMark;

describe('threat library', () => {
  it('covers all three defeat classes with hostile types', () => {
    const classes = new Set(Object.values(T).filter((t) => t.hostile).map((t) => decisionClass(t)));
    expect([...classes].sort()).toEqual(['autonomous', 'gnssOnly', 'rfLinked']);
  });

  // Non-hostile contacts alone end a drill at once (nothing to defend against); they are covered by scoring.test.ts.
  for (const k of C.threats.order.filter((id) => T[id].hostile)) {
    it(`the expert ghost handles "${k}" to the pass mark`, () => {
      const E = single(k, {}, 75);
      drive(E, expertPolicy);
      const sc = scoreRun(E);
      expect(sc).toHaveLength(1);
      expect(runTotal(sc)).toBeGreaterThanOrEqual(pass);
      expect(E.contacts[0].state).toBe('neutralised');
    });
  }

  it('surveillance UAVs fly in, then circle at standoff range without reaching the asset', () => {
    for (const k of Object.keys(T).filter((id) => T[id].motion === 'surveil')) {
      const E = single(k, {}, 200);
      const c0 = () => E.contacts[0];
      while (!isDone(E) && E.tick < ticks(C, 150)) step(E, []);
      const c = c0(), r = Math.hypot(c.x, c.y), [o0, o1] = T[k].orbitRadiusM!;
      expect(c.state).toBe('live');
      expect(c.hover).toBe(true);
      expect(r).toBeGreaterThanOrEqual(o0 - 1);
      expect(r).toBeLessThanOrEqual(o1 + 1);
      expect(tti(c, C)).toBe(Infinity);
      const s = scoreRun(E)[0];
      expect(s.missed || s.F === 0).toBe(true); // left unchallenged earns no defeat points
    }
  });

  it('a fibre-optic FPV cannot be jammed or spoofed', () => {
    expect(decisionClass(T.fibre)).toBe('autonomous');
    expect(C.doctrine.defeat.tables.autonomous.jam).toBe(0);
    expect(C.doctrine.defeat.tables.autonomous.spoof).toBe(0);
  });
});
