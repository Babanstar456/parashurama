import { describe, expect, it } from 'vitest';
import { buildScenario, createEngine, expertPolicy, isCleared, needsClearance, observe, runTotal, scoreRun, type Engine, type Spawn } from '../src';
import { C, baseCfg, controller, drive, single } from './helpers';

const only = (E: ReturnType<typeof single>) => { const s = scoreRun(E); expect(s).toHaveLength(1); return s[0]; };

describe('golden scoring: every doctrine rule gives the expected points', () => {
  it('R3: radio-controlled recon, jammed → full defeat points', () => {
    const E = single('recon');
    drive(E, controller({ eff: () => 'jam' }));
    const s = only(E);
    expect(E.contacts[0].state).toBe('neutralised');
    expect(s.D).toBe(30);
    expect(s.C).toBe(29); // 18 + 12 × 0.95
    expect(s.F).toBe(40);
    expect(s.total).toBe(99);
    expect(s.rules).toContain('R3');
  });

  it('R4: jamming a loitering munition has no effect and scores 0 for the decision', () => {
    const E = single('loiter');
    drive(E, (Eng) => {
      const base = controller({})(Eng);
      const c = Eng.contacts[0];
      if (!c) return base;
      if (c.idTick != null && c.effectAt == null && c.state === 'live') {
        const last = c.engs[c.engs.length - 1];
        if (!last && Math.hypot(c.x, c.y) <= 2000) base.push({ k: 'eng', cid: c.id, eff: 'jam', tick: Eng.tick });
        else if (last && !last.effective && Math.hypot(c.x, c.y) <= 2500) base.push({ k: 'eng', cid: c.id, eff: 'spoof', tick: Eng.tick });
      }
      return base;
    });
    const s = only(E);
    expect(E.contacts[0].engs[0]).toMatchObject({ eff: 'jam', effective: false });
    expect(E.contacts[0].state).toBe('neutralised'); // the follow-up spoof worked
    expect(s.F).toBe(0);
    expect(s.rules).toContain('R4');
    expect(s.why.join(' ')).toMatch(/no radio link/i);
  });

  it('R4: GNSS spoof on a loitering munition → full defeat points', () => {
    const E = single('loiter');
    drive(E, controller({ eff: () => 'spoof' }));
    const s = only(E);
    expect(s.F).toBe(40);
    expect(s.total).toBe(99);
  });

  it('R1: friendly held → 40; friendly engaged → 0 (fratricide)', () => {
    const held = single('friendly');
    drive(held, controller({ eff: () => 'hold' }), 30, false);
    expect(only(held).F).toBe(40);
    const shot = single('friendly');
    drive(shot, controller({ eff: () => 'intc' }), 40, false);
    const s = only(shot);
    expect(s.F).toBe(0);
    expect(s.why.join(' ')).toMatch(/fratricide/);
  });

  it('R2: bird held → 40; effector wasted on a bird → 10', () => {
    const held = single('bird', {}, 90);
    drive(held, controller({ eff: () => 'hold' }), 30, false);
    expect(only(held).F).toBe(40);
    const shot = single('bird', {}, 90);
    drive(shot, controller({ eff: () => 'intc' }), 40, false);
    expect(only(shot).F).toBe(10);
  });

  it('R6: gun in an urban area costs 15 points', () => {
    const E = single('fpv', { terrain: 'urban' });
    drive(E, controller({ eff: () => 'gun' }));
    const s = only(E);
    expect(s.Fbase).toBe(28);
    expect(s.F).toBe(13);
    expect(s.rules).toContain('R6');
  });

  it('R7: engaging with under 8 s to impact costs 8 points', () => {
    const E = single('loiter');
    drive(E, controller({ eff: () => 'spoof', engageIf: (c) => Math.hypot(c.x, c.y) <= 400 }));
    const s = only(E);
    expect(E.contacts[0].state).toBe('neutralised');
    expect(s.F).toBe(32);
    expect(s.rules).toContain('R7');
  });

  it('R5: leaving a more urgent threat waiting costs 5 points', () => {
    const sp: Spawn[] = [{ type: 'loiter', t: 0, brg: 0 }, { type: 'fpv', t: 25, brg: 180 }];
    const E = createEngine(baseCfg(), C, sp);
    drive(E, controller({
      eff: (c) => (c.type === 'fpv' ? 'intc' : 'spoof'),
      engageIf: (c, Eng) => {
        const loiter = Eng.contacts.find((o) => o.type === 'loiter')!;
        const fpv = Eng.contacts.find((o) => o.type === 'fpv');
        if (c.type === 'fpv') return Math.hypot(loiter.x, loiter.y) <= 1000;
        return !!fpv && fpv.engs.length > 0; // loiter only after the fpv was engaged
      },
    }));
    const fpv = scoreRun(E).find((s) => s.c.type === 'fpv')!;
    expect(fpv.Fbase).toBe(30);
    expect(fpv.F).toBe(25);
    expect(fpv.rules).toContain('R5');
  });

  it('R8: a hostile that reaches the asset scores 0 for defeat', () => {
    const E = single('loiter');
    drive(E, controller({ eff: () => null }));
    const s = only(E);
    expect(E.contacts[0].state).toBe('leaked');
    expect(s.F).toBe(0);
    expect(s.rules).toContain('R8');
  });

  it('D1: tracking 10 s after the first radar paint scores 18 of 30', () => {
    const E = single('recon');
    drive(E, controller({ trackAfterPaintSec: 10, ignoreVisibility: true, eff: () => 'jam' }));
    expect(only(E).D).toBe(18);
  });

  it('C1: wrong identification scores by confidence and friend/foe', () => {
    const sameSide = single('loiter');
    drive(sameSide, controller({ cls: () => 'recon', conf: 0.6, eff: () => null }));
    expect(only(sameSide).C).toBe(9); // 10 × 0.4 + 5
    const wrongSide = single('loiter');
    drive(wrongSide, controller({ cls: () => 'friendly', conf: 0.6, eff: () => null }));
    expect(only(wrongSide).C).toBe(4);
  });

  it('a hostile that is never tracked scores 0 and is marked missed', () => {
    const E = single('loiter');
    drive(E, () => []);
    const s = only(E);
    expect(s.missed).toBe(true);
    expect(s.total).toBe(0);
  });

  it('area spoof on a swarm credits every neighbour it neutralised', () => {
    const sp: Spawn[] = [0, 0.35, 0.7, 1.05].map((t) => ({ type: 'swarm', t, brg: 45 }));
    const E = createEngine(baseCfg({ pattern: 'swarm' }), C, sp);
    let engaged = false;
    drive(E, (Eng) => {
      const acts = controller({})(Eng).filter((a) => a.k === 'track' || a.cid === Eng.contacts[0]?.id);
      const first = Eng.contacts[0];
      if (!engaged && first && first.idTick != null && Math.hypot(first.x, first.y) <= 2500) { acts.push({ k: 'eng', cid: first.id, eff: 'spoof', tick: Eng.tick }); engaged = true; }
      return acts;
    });
    const sc = scoreRun(E);
    for (const s of sc) expect(s.C).toBe(29); // tracked-but-unidentified neighbours inherit the engaged drone's identification
    expect(E.contacts.every((c) => c.state === 'neutralised')).toBe(true);
    expect(E.contacts.filter((c) => c.area).length).toBeGreaterThan(0);
    for (const s of sc) expect(s.F).toBe(40);
  });
});

describe('golden scoring: military threat library (items 1–2)', () => {
  it('R4 autonomous: jamming a fibre-optic FPV → defeat 0; interceptor → 40', () => {
    const jam = single('fibre');
    drive(jam, controller({ eff: () => 'jam' }), 60);
    const sj = only(jam);
    expect(jam.contacts[0].engs[0]).toMatchObject({ eff: 'jam', effective: false });
    expect(sj.F).toBe(0);
    expect(sj.rules).toContain('R4');
    const intc = single('fibre');
    drive(intc, controller({ eff: () => 'intc' }));
    const si = only(intc);
    expect(intc.contacts[0].state).toBe('neutralised');
    expect(si.F).toBe(40);
  });

  it('R3: a large military UAV is jammed on its datalink → 40; left circling unchallenged → 0', () => {
    const jam = single('male');
    drive(jam, controller({ eff: () => 'jam' }));
    const s = only(jam);
    expect(jam.contacts[0].state).toBe('neutralised');
    expect(s.F).toBe(40);
    expect(s.rules).toContain('R3');
    const left = single('male');
    drive(left, controller({ eff: () => null }), 150);
    const sl = only(left);
    expect(left.contacts[0].hover).toBe(true);
    expect(sl.F).toBe(0);
    expect(sl.why.join(' ')).toMatch(/watch the asset unchallenged/);
  });
});

describe('golden scoring: civil drones (item 3, R9)', () => {
  it('R9: civil drone held → 40; engaged → 0', () => {
    const held = single('civil');
    drive(held, controller({ eff: () => 'hold' }), 30, false);
    const sh = only(held);
    expect(sh.F).toBe(40);
    expect(sh.rules).toContain('R9');
    expect(sh.why.join(' ')).toMatch(/reported and monitored/);
    const shot = single('civil');
    drive(shot, controller({ eff: () => 'intc' }), 40, false);
    expect(shot.contacts[0].engs[0]?.eff).toBe('intc');
    const ss = only(shot);
    expect(ss.F).toBe(0);
    expect(ss.why.join(' ')).toMatch(/unlawful/);
  });

  it('urban drills gain one civil drone only when civilType is configured', () => {
    const noCivil = { ...C, training: { ...C.training, scenario: { ...C.training.scenario, civilType: undefined } } };
    for (const seed of [3, 17, 99]) {
      const cfg = baseCfg({ seed, terrain: 'urban' });
      const before = buildScenario(cfg, noCivil), after = buildScenario(cfg, C);
      expect(before.some((s) => s.type === 'civil')).toBe(false);
      expect(after.filter((s) => s.type === 'civil')).toHaveLength(1);
      expect(after.filter((s) => s.type !== 'civil')).toEqual(before);
      expect(buildScenario(baseCfg({ seed, terrain: 'rural' }), C)).toEqual(buildScenario(baseCfg({ seed, terrain: 'rural' }), noCivil));
    }
  });
});

describe('golden scoring: probability of kill and re-engagement (item 4, R10)', () => {
  const withPk = (pk: Record<string, number>) => ({ ...C, effectors: { ...C.effectors, effectors: Object.fromEntries(Object.entries(C.effectors.effectors).map(([k, e]) => [k, { ...e, pk: pk[k] ?? e.pk }])) } });
  const one = (cfg: typeof C, type: string) => createEngine(baseCfg(), cfg, [{ type, t: 0, brg: 90 }]);

  it('pk 0: the jam is recorded as a miss and the drone stays live', () => {
    const E = one(withPk({ jam: 0 }), 'recon');
    drive(E, controller({ eff: () => 'jam' }), 150, false);
    expect(E.contacts[0].engs[0]).toMatchObject({ eff: 'jam', effective: true, miss: true });
    expect(E.contacts[0].effectAt).toBeNull();
  });

  it('R10: a miss followed by a leak with no re-engagement is called out', () => {
    const E = one(withPk({ jam: 0 }), 'fpv');
    drive(E, controller({ eff: () => 'jam' }));
    const s = scoreRun(E)[0];
    expect(E.contacts[0].state).toBe('leaked');
    expect(s.F).toBe(0);
    expect(s.rules).toEqual(expect.arrayContaining(['R8', 'R10']));
  });

  it('R10: a miss on a drone still live at the end costs −10', () => {
    const E = one(withPk({ jam: 0 }), 'recon');
    drive(E, controller({ eff: () => 'jam' }), 150, false);
    const s = scoreRun(E)[0];
    expect(E.contacts[0].state).toBe('live');
    expect(s.Fbase).toBe(40);
    expect(s.F).toBe(30);
    expect(s.rules).toContain('R10');
  });

  it('a miss then a successful re-engagement keeps full credit for the first choice', () => {
    const E = one(withPk({ jam: 0 }), 'recon');
    drive(E, (Eng) => { const c = Eng.contacts[0]; const a = controller({ eff: () => 'jam' })(Eng); if (c?.engs[0]?.miss && c.engs.length === 1) a.push({ k: 'eng', cid: c.id, eff: 'intc', tick: Eng.tick }); return a; });
    const s = scoreRun(E)[0];
    expect(E.contacts[0].state).toBe('neutralised');
    expect(s.F).toBe(40);
    expect(s.rules).not.toContain('R10');
  });

  it('misses are deterministic: the same seed gives the same misses', () => {
    const cfg = withPk({ jam: 0.5, spoof: 0.5, intc: 0.5, gun: 0.5 });
    const run = () => { const E = createEngine(baseCfg({ seed: 4321, difficulty: 5 }), cfg); drive(E, expertPolicy); return E.contacts.flatMap((c) => c.engs.map((e) => `${c.id}:${e.tick}:${e.eff}:${!!e.miss}`)); };
    const a = run();
    expect(a.some((x) => x.endsWith(':true'))).toBe(true);
    expect(run()).toEqual(a);
  });

  it('the expert ghost re-engages after a miss', () => {
    const E = one(withPk({ jam: 0 }), 'recon');
    drive(E, expertPolicy);
    const c = E.contacts[0];
    expect(c.engs[0]).toMatchObject({ eff: 'jam', miss: true });
    expect(c.engs.length).toBeGreaterThan(1);
    expect(c.state).toBe('neutralised');
  });
});

describe('golden scoring: rules of engagement and clearance (item 6, R12)', () => {
  const peace = (o = {}) => baseCfg({ roe: 'peacetime', ...o });
  const reqThen = (eff: string) => (Eng: Engine) => {
    const a = controller({ eff: () => eff, engageIf: (c, E) => isCleared(E, c, eff) })(Eng);
    for (const c of Eng.contacts) if (c.idTick != null && c.clrReq == null) a.push({ k: 'req', cid: c.id, tick: Eng.tick });
    return a;
  };

  it('R12: under peacetime ROE an RF jam without clearance costs −40', () => {
    const E = createEngine(peace(), C, [{ type: 'recon', t: 0, brg: 90 }]);
    drive(E, controller({ eff: () => 'jam' }));
    const s = scoreRun(E)[0];
    expect(E.contacts[0].engs[0].cleared).toBe(false);
    expect(E.contacts[0].state).toBe('neutralised'); // the effect still happens; the penalty is in scoring
    expect(s.Fbase).toBe(40);
    expect(s.F).toBe(0);
    expect(s.rules).toContain('R12');
  });

  it('requesting clearance, waiting, then engaging earns full points', () => {
    const E = createEngine(peace(), C, [{ type: 'recon', t: 0, brg: 90 }]);
    drive(E, reqThen('jam'));
    const c = E.contacts[0], s = scoreRun(E)[0];
    expect(c.clrReq).not.toBeNull();
    expect(c.engs[0].tick).toBeGreaterThanOrEqual(c.clrAt!);
    expect(c.engs[0].cleared).toBe(true);
    expect(s.F).toBe(40);
    expect(s.rules).not.toContain('R12');
  });

  it('tight ROE: jamming needs no clearance, the gun does', () => {
    const E = createEngine(baseCfg({ roe: 'tight' }), C, [{ type: 'recon', t: 0, brg: 90 }]);
    expect(needsClearance(E, 'jam')).toBe(false);
    expect(needsClearance(E, 'gun')).toBe(true);
  });

  it('drills without roe record no clearance data (old drills unchanged)', () => {
    const E = single('recon');
    drive(E, controller({ eff: () => 'jam' }));
    expect('cleared' in E.contacts[0].engs[0]).toBe(false);
    expect(E.contacts[0].clrReq).toBeUndefined();
  });

  it('the expert ghost requests clearance and wins a peacetime drill', () => {
    const E = createEngine(peace({ seed: 2024, difficulty: 4 }), C);
    const log = drive(E, expertPolicy);
    expect(log.some((a) => a.k === 'req')).toBe(true);
    const sc = scoreRun(E);
    expect(sc.every((s) => !s.rules.includes('R12'))).toBe(true);
    expect(runTotal(sc)).toBeGreaterThanOrEqual(C.training.certification.passMark);
  });

  it('the roe skill is observed only under a restrictive ROE', () => {
    const E = createEngine(peace(), C, [{ type: 'recon', t: 0, brg: 90 }]);
    drive(E, controller({ eff: () => 'jam' }));
    expect(observe(E, scoreRun(E)).roe).toEqual([false]);
    const F = single('recon');
    drive(F, controller({ eff: () => 'jam' }));
    expect(observe(F, scoreRun(F)).roe).toEqual([]);
  });
});
