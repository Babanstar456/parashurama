import { describe, expect, it } from 'vitest';
import { calStats, demoHistory, expertPolicy, planNext, runSim, scoreRun, type Action, type Engine } from '../src';
import { C, baseCfg, controller, drive, single } from './helpers';

// Control measures from the doctrine review (all optional; drills without them score exactly as before):
// R13 Weapon Control Status, R14 safe arcs, R15 kill assessment, and the explicit "Unknown" identification.
const one = (E: Engine) => scoreRun(E)[0];

describe('Unknown identification', () => {
  it('is a legitimate answer worth 10 identification points, and can be upgraded later', () => {
    const E = single('recon');
    drive(E, controller({ cls: () => 'unknown', eff: () => 'jam' }));
    const s = one(E);
    expect(E.contacts[0].idCls).toBe('unknown');
    expect(s.C).toBe(10);
    const F = single('recon');
    let upgraded = false;
    drive(F, (x) => {
      const c = x.contacts[0], base = controller({ cls: () => 'unknown', eff: () => 'jam' })(x).filter((a) => a.k !== 'eng');
      if (c && c.idCls === 'unknown' && !upgraded && x.tick > (c.idTick ?? 0) + 10) { upgraded = true; return [...base, { k: 'id', cid: c.id, cls: 'recon', conf: 0.95, tick: x.tick } as Action]; }
      return c && c.idCls === 'recon' && !c.engs.length ? [...base, { k: 'eng', cid: c.id, eff: 'jam', tick: x.tick } as Action] : base;
    });
    expect(F.contacts[0].idCls).toBe('recon');
    expect(one(F).C).toBe(29);
  });
  it('is left out of confidence calibration', () => {
    const E = single('recon');
    drive(E, controller({ cls: () => 'unknown', eff: () => 'jam' }));
    expect(Object.values(calStats(scoreRun(E), C)).every(([n]) => n === 0)).toBe(true);
  });
});

describe('R13 Weapon Control Status', () => {
  it('WEAPONS TIGHT: engaging a contact declared Unknown costs 20', () => {
    const E = single('recon', { wcs: 'tight' });
    drive(E, controller({ cls: () => 'unknown', eff: () => 'jam' }));
    const s = one(E);
    expect(s.rules).toContain('R13');
    expect(s.F).toBe(20);
  });
  it('WEAPONS FREE: the same engagement is allowed', () => {
    const E = single('recon', { wcs: 'free' });
    drive(E, controller({ cls: () => 'unknown', eff: () => 'jam' }));
    expect(one(E).rules).not.toContain('R13');
  });
  it('WEAPONS HOLD: engaging far out costs 20; the expert waits for self-defence range and loses nothing', () => {
    const E = single('loiter', { wcs: 'hold' });
    drive(E, controller({ eff: () => 'spoof' }));
    expect(one(E).rules).toContain('R13');
    const X = single('loiter', { wcs: 'hold' });
    drive(X, expertPolicy);
    const s = one(X);
    expect(s.rules).not.toContain('R13');
    expect(X.contacts[0].state).toBe('neutralised');
  });
});

describe('R14 safe arcs', () => {
  it('a gun fired into a safe arc costs 20; the expert uses the interceptor there instead', () => {
    // A loitering munition from bearing 90 (no radio): the expert would normally pick the interceptor or the gun by points.
    const arcs: [number, number][] = [[70, 110]];
    const E = single('swarm', { safeArcs: arcs }, 90);
    drive(E, controller({ eff: () => 'gun' }));
    const s = one(E);
    expect(s.rules).toContain('R14');
    const X = single('swarm', { safeArcs: arcs }, 90);
    drive(X, expertPolicy);
    expect(X.contacts[0].engs.every((e) => e.eff !== 'gun')).toBe(true);
    expect(one(X).rules).not.toContain('R14');
  });
});

describe('R15 kill assessment', () => {
  it('a kill not reported costs 5; a payload drone asks for its crash site to be marked', () => {
    const E = single('dropper', { killAssess: true });
    drive(E, controller({ eff: () => 'jam' }));
    const s = one(E);
    expect(s.rules).toContain('R15');
    expect(s.why.join()).toMatch(/crash site/i);
    const X = single('dropper', { killAssess: true });
    drive(X, expertPolicy, 150, false);
    expect(one(X).rules).not.toContain('R15');
  });
  it('drills without the measures replay exactly as before', () => {
    const a = runSim(baseCfg({ seed: 99 }), { policy: expertPolicy, stopWhenDone: true });
    const b = runSim(baseCfg({ seed: 99, wcs: undefined, safeArcs: undefined, killAssess: undefined }), { policy: expertPolicy, stopWhenDone: true });
    expect(JSON.stringify(a.contacts)).toBe(JSON.stringify(b.contacts));
  });
});

describe('the enemy AI adds control measures without changing the conditions it targets', () => {
  it('kill assessment from the second drill; WCS and sometimes a safe arc from level 3', () => {
    const H = demoHistory();
    const p = planNext(H);
    expect(p.cfg.killAssess).toBe(true);
    if (p.cfg.difficulty >= 3) expect(['hold', 'tight', 'free']).toContain(p.cfg.wcs);
    const kinds = new Set<string>();
    for (let i = 0; i < 30; i++) { const c = planNext(H.map((s, j) => ({ ...s, total: 60 + i + j }))).cfg; kinds.add(String(c.wcs)); }
    expect(kinds.size).toBeGreaterThanOrEqual(2);
  });
});
