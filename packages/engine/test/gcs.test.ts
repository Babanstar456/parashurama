import { describe, expect, it } from 'vitest';
import { createGcs, defaultGcsCfg, runGcs, scoreGcs, stepGcs, uavAI, type UavAction, type UavEngine } from '../src';

const play = (seed: number, policy: (E: UavEngine) => UavAction[] = uavAI) => { const log: UavAction[] = []; const E = runGcs(defaultGcsCfg({ seed }), { policy: (x) => { const a = policy(x); log.push(...a.map((y) => ({ ...y, tick: x.tick }))); return a; }, stopWhenDone: true }); return { E, log }; };

describe('UAV ground-control-station strike drill', () => {
  it('the expert flies every mission cleanly: in the corridor, cleared, on target, safe, home', () => {
    const misses: number[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      const { E } = play(seed), s = scoreGcs(E);
      expect(E.phase).toBe('landed');
      expect(E.impact?.hit).toBe(true);
      expect(s.deductions.every((d) => d.pts === 0)).toBe(true);
      expect(s.total).toBeGreaterThanOrEqual(95);
      misses.push(E.impact!.miss);
    }
    console.log(`EVIDENCE UAV strike drill, expert over 10 missions: all landed, all hits, miss ${Math.min(...misses).toFixed(1)}–${Math.max(...misses).toFixed(1)} m (lethal radius 8 m)`);
  });
  it('is deterministic: the log replays to the same result', () => {
    const { E, log } = play(3);
    const R = runGcs(E.cfg, { actions: log, until: E.tick });
    expect(R.impact).toEqual(E.impact);
    expect(scoreGcs(R).total).toBe(scoreGcs(E).total);
  });
  it('U4: the Master Arm interlock blocks release; releasing before CLEAR TO ENGAGE costs 40', () => {
    const E = createGcs(defaultGcsCfg({ seed: 4 }));
    for (let i = 0; i < 2000 && E.phase !== 'loiter'; i++) stepGcs(E, uavAI(E).filter((a) => a.k !== 'reqEngage'));
    stepGcs(E, [{ tick: E.tick, k: 'release' }]);
    expect(E.release).toBeNull(); // not armed: interlock
    const eager = (x: UavEngine): UavAction[] => (x.phase === 'run' && x.runStage === 1 && !x.release && x.engageClearTick == null ? [{ tick: x.tick, k: 'release' }] : uavAI(x).map((a) => (a.k === 'reqEngage' ? { ...a, k: 'arm', on: true } as UavAction : a)));
    const bad = scoreGcs(play(4, (x) => (x.engageClearTick == null && x.phase === 'loiter' && !x.arm ? [{ tick: x.tick, k: 'arm', on: true }, { tick: x.tick, k: 'run' }] : eager(x))).E);
    const u4 = bad.deductions.find((d) => d.rule === 'U4')!;
    expect(u4.pts).toBeLessThanOrEqual(-40);
  });
  it('U3 and U1: cutting the corner over the village and skipping checks cost points', () => {
    // Skips the geofence check (acts as if it were done) and cuts straight to the IP over the village.
    const cut = (x: UavEngine) => [...uavAI({ ...x, checks: { fence: 0, ...x.checks } } as UavEngine), ...(x.phase === 'transit' && x.wp === 1 ? [{ tick: x.tick, k: 'direct' } as UavAction] : [])];
    const s = scoreGcs(play(2, cut).E);
    expect(s.deductions.find((d) => d.rule === 'U3')!.pts).toBeLessThan(0);
    expect(s.deductions.find((d) => d.rule === 'U1')!.pts).toBeLessThan(0);
  });
  it('U6: locking the civilian vehicle gets the engagement refused and halves the find-and-lock credit', () => {
    const civ = (x: UavEngine): UavAction[] => {
      const c = x.objs.find((o) => o.kind === 'civil')!;
      if (x.phase === 'loiter' && x.denied === 0) { const save = x.target; x.target = c; const a = uavAI(x); x.target = save; return a.filter((y) => y.k !== 'reqEngage').concat(x.lock?.id === c.id ? [{ tick: x.tick, k: 'reqEngage' }] : []); }
      return uavAI(x);
    };
    const { E } = play(5, civ);
    expect(E.denied).toBeGreaterThan(0);
    expect(scoreGcs(E).parts.find((p) => p.rule === 'U6')!.why.join()).toMatch(/civilian/);
  });
});
