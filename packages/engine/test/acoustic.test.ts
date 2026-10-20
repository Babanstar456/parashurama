import { describe, expect, it } from 'vitest';
import { acousticClue, acousticRange, expertPolicy, runSim, scoreRun, step, validateConfig, type Config } from '../src';
import { baseCfg, C, single } from './helpers';

const noAcoustic = (): Config => { const c = JSON.parse(JSON.stringify(C)) as Config; delete c.training.acoustic; return c; };

describe('acoustic sensing (optional sensor, clue only)', () => {
  it('the shipped config fits an acoustic sensor and every threat has a signature', () => {
    expect(validateConfig(C).ok).toBe(true);
    expect(C.training.acoustic).toBeDefined();
    for (const id of C.threats.order) expect(C.threats.threats[id].acoustic, id).toBeDefined();
  });
  it('a config without the acoustic block is still valid and shows no acoustic clue (old configs unchanged)', () => {
    const c = noAcoustic();
    expect(validateConfig(c).ok).toBe(true);
    expect(acousticRange(c, 'fibre', { time: 'day', terrain: 'rural' })).toBeNull();
    const E = single('fibre', {}, 90); E.C = c; step(E, []);
    expect(acousticClue(E, E.contacts[0])).toBeNull();
  });
  it('a fitted sensor needs a signature for every threat in the library', () => {
    const c = JSON.parse(JSON.stringify(C)) as Config; delete c.threats.threats.fibre.acoustic;
    expect(validateConfig(c).errors.join()).toMatch(/fibre.*acoustic signature/);
  });
  it('hearing range: shorter in towns, rain and dust; longer at night', () => {
    const base = C.threats.threats.fibre.acoustic!.rangeM, r = (o: object) => acousticRange(C, 'fibre', { time: 'day', terrain: 'rural', ...o })!;
    expect(r({})).toBe(base);
    expect(r({ terrain: 'urban' })).toBeLessThan(base);
    expect(r({ weather: 'rain' })).toBeLessThan(base);
    expect(r({ weather: 'dust' })).toBeLessThan(base);
    expect(r({ weather: 'fog' })).toBe(base);
    expect(r({ time: 'night' })).toBeGreaterThan(base);
    console.log(`EVIDENCE acoustic hearing range for a fibre-optic FPV (m): rural day ${r({})}, urban day ${r({ terrain: 'urban' })}, rural night ${r({ time: 'night' })}, urban in rain ${Math.round(r({ terrain: 'urban', weather: 'rain' }))}`);
  });
  it('a fibre-optic FPV, silent on RF, is heard once it comes within range', () => {
    const E = single('fibre', {}, 90);
    let first: number | null = null;
    for (let i = 0; i < 2000 && E.contacts[0]?.state !== 'leaked'; i++) {
      step(E, []);
      const c = E.contacts[0], a = c && acousticClue(E, c);
      if (a?.heard && first == null) first = Math.hypot(c.x, c.y);
    }
    expect(C.threats.threats.fibre.rfOn).toBe(false);
    expect(first).not.toBeNull();
    expect(first!).toBeLessThan(C.threats.threats.fibre.acoustic!.rangeM);
  });
  it('the acoustic sensor never changes a drill or its score', () => {
    for (const seed of [3, 41, 977]) {
      const cfg = baseCfg({ seed, terrain: 'urban', time: 'night' });
      const a = runSim(cfg, { policy: expertPolicy, stopWhenDone: true });
      const b = runSim(cfg, { policy: expertPolicy, stopWhenDone: true }, noAcoustic());
      expect(JSON.stringify(a.contacts)).toBe(JSON.stringify(b.contacts));
      expect(scoreRun(a).map((s) => s.total)).toEqual(scoreRun(b).map((s) => s.total));
    }
  });
});
