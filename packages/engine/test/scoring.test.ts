import { describe, expect, it } from 'vitest';
import { createEngine, scoreRun, type Spawn } from '../src';
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
