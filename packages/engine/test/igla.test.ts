import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  angDiff, createIgla, defaultIglaCfg, iBlocked, iEye, iglaAI, IGLA, IGLA_RULES, iOffBore, losOf, runIgla, scoreIgla, segBlocked, stepIgla,
  type IglaAction, type IglaEngine, type ITarget, type PatrolWorld, type Vec3,
} from '../src';

// The baked city snippet (apps/web/public/city) is the drill's world, as for the urban patrol.
const W: PatrolWorld = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../apps/web/public/city/city.json'), 'utf8')).world;
const play = (seed: number, o: Partial<ReturnType<typeof defaultIglaCfg>> = {}) => {
  const log: IglaAction[] = [];
  const E = runIgla(defaultIglaCfg({ seed, ...o }), W, { policy: (x) => { const a = iglaAI(x); log.push(...a.map((y) => ({ ...y, tick: x.tick }))); return a; } });
  return { E, log };
};
const step = (E: IglaEngine, a: Omit<IglaAction, 'tick'>[] = []) => stepIgla(E, a.map((x) => ({ ...x, tick: E.tick })));
const run = (E: IglaEngine, sec: number, a: (E: IglaEngine) => Omit<IglaAction, 'tick'>[] = () => []) => { for (let i = 0; i < Math.round(sec / E.dt); i++) step(E, a(E)); };

/** A quiet drill (no scenario) with one drone placed on a bearing the gunner can see and fire along. With `crossV` it
 *  flies across the line of sight at that speed; without, it hovers. */
function single(type: string, range: number, alt: number, crossV = 0): { E: IglaEngine; T: ITarget } {
  const E = createIgla(defaultIglaCfg({ seed: 3, difficulty: 1 }), W); E.spawns = [];
  const e = iEye(E), at = (az: number): Vec3 => [e[0] + Math.sin((az * Math.PI) / 180) * range, e[1] + Math.cos((az * Math.PI) / 180) * range, alt];
  const clear = (az: number) => [-8, 0, 8].every((k) => segBlocked(E, e, at(az + k)) == null) && segBlocked(E, e, [...at(az).slice(0, 2), alt + range * 0.12] as Vec3) == null;
  const best = Array.from({ length: 72 }, (_, i) => i * 5).find(clear) ?? 0;
  const a = (best * Math.PI) / 180, p = at(best);
  if (crossV) E.C = { ...E.C, threats: { ...E.C.threats, threats: { ...E.C.threats.threats, [type]: { ...E.C.threats.threats[type], speed: crossV } } } };
  const T: ITarget = { id: 1, type, hostile: E.C.threats.threats[type].hostile, value: IGLA.types[type].value, goal: crossV ? 'transit' : 'hover', spawnTick: 0, p, prev: [...p] as Vec3,
    v: [Math.cos(a) * crossV, -Math.sin(a) * crossV, 0], gx: crossV ? p[0] + Math.cos(a) * 1e5 : p[0], gy: crossV ? p[1] - Math.sin(a) * 1e5 : p[1], gz: alt, orbitR: 0, aux: 0, state: 'live', endTick: null };
  E.targets.push(T);
  const L = losOf([p[0] - e[0], p[1] - e[1], p[2] - e[2]]); E.sol.az = L.az; E.sol.el = L.el;
  return { E, T };
}
/** Shoulder, switch on, hold the target in the ring; once locked lift for lead and super-elevation (or not) and fire. */
const shooter = (T: ITarget, lead = true) => (E: IglaEngine): Omit<IglaAction, 'tick'>[] => {
  const out: Omit<IglaAction, 'tick'>[] = [{ k: 'raise', on: true }];
  if (E.lch.bcu === 'fitted') out.push({ k: 'power' });
  const e = iEye(E), L = losOf([T.p[0] - e[0], T.p[1] - e[1], T.p[2] - e[2]]), L1 = losOf([T.p[0] + T.v[0] - e[0], T.p[1] + T.v[1] - e[1], T.p[2] - e[2]]);
  const rate = angDiff(L1.az, L.az);
  if (E.lch.seeker === 'lock' && lead) out.push({ k: 'look', az: L.az + (Math.abs(rate) > 0.4 ? Math.sign(rate) * Math.min(6, Math.abs(rate) * 2) : 0), el: L.el + 6 });
  else out.push({ k: 'look', az: L.az, el: L.el });
  if (E.lch.seeker === 'lock' && E.lch.trigAt == null && E.tick % 2 === 1) out.push({ k: 'trig', on: true });
  return out;
};

describe('Igla (MANPADS) drill on foot', () => {
  it('starts the gunner clear of obstacles, with something worth a missile, something not, and something never to engage', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const E = createIgla(defaultIglaCfg({ seed, difficulty: 3 }), W), v = new Set(E.spawns.map((s) => IGLA.types[s.type]?.value));
      expect(iBlocked(E, E.sol.x, E.sol.y)).toBe(false);
      expect(v.has('high') && v.has('low') && v.has('never')).toBe(true);
      expect(E.lch).toMatchObject({ tube: 'live', bcu: 'fitted', tubes: IGLA.tubes - 1, bcus: IGLA.bcus - 1 });
    }
    expect(createIgla(defaultIglaCfg({ seed: 4 }), W).spawns).toEqual(createIgla(defaultIglaCfg({ seed: 4 }), W).spawns);
    expect(createIgla(defaultIglaCfg({ seed: 4, difficulty: 4 }), W).spawns).not.toEqual(createIgla(defaultIglaCfg({ seed: 4, difficulty: 5 }), W).spawns);
  });
  it('the battery-coolant unit: seeker ready after 5 s, spent after 35 s if nothing is fired; then a fresh one is needed', () => {
    const { E } = single('tacIsr', 2000, 300);
    step(E, [{ k: 'power' }]);
    expect(E.lch.bcu).toBe('active'); expect(E.lch.seeker).toBe('cooling');
    run(E, IGLA.readySec);
    expect(E.ev.some((e) => e.k === 'ready')).toBe(true);
    run(E, IGLA.bcuSec);
    expect(E.lch.bcu).toBe('spent'); expect(E.bcuWasted).toBe(1); expect(E.ev.some((e) => e.k === 'bcuOut')).toBe(true);
    step(E, [{ k: 'power' }]); expect(E.ev[E.ev.length - 1]).toMatchObject({ k: 'powerFail', text: 'bcu' });
    step(E, [{ k: 'bcu' }]); run(E, IGLA.bcuFitSec + 0.2);
    expect(E.lch.bcu).toBe('fitted'); expect(E.lch.bcus).toBe(IGLA.bcus - 2);
    expect(scoreIgla(E).rules).toContain('I6');
  });
  it('launch interlock: the trigger does nothing until the seeker has locked (tone and light)', () => {
    const { E, T } = single('tacIsr', 2000, 300);
    step(E, [{ k: 'trig', on: true }]);
    expect(E.ev[E.ev.length - 1]).toMatchObject({ k: 'noLaunch', text: 'raise' });
    run(E, 1, () => [{ k: 'raise', on: true }]); step(E, [{ k: 'power' }]); step(E, [{ k: 'trig', on: true }]);
    expect(E.ev.filter((e) => e.k === 'noLaunch').pop()).toMatchObject({ text: 'cooling' });
    // Aim well off the target: the seeker searches, finds nothing, and the trigger still will not launch.
    const az0 = E.sol.az;
    run(E, IGLA.readySec + 1, () => [{ k: 'look', az: az0 + 40, el: 45 }, { k: 'trig', on: true }]);
    expect(E.missiles.length).toBe(0); expect(E.lch.seeker).toBe('search');
    // On the target: acquire, lock, launch.
    run(E, 3, shooter(T));
    expect(E.ev.some((e) => e.k === 'lock')).toBe(true); expect(E.missiles.length).toBe(1);
    expect(E.lch).toMatchObject({ tube: 'spent', bcu: 'spent' });
  });
  it('fire and forget: the missile homes on a crossing target with lead and super-elevation and destroys it', () => {
    const { E, T } = single('tacIsr', 2200, 300, 40);
    run(E, 25, shooter(T));
    const l = E.launches[0];
    expect(l.superOk && l.leadOk && l.envOk).toBe(true);
    expect(T.state).toBe('destroyed'); expect(E.missiles[0].state).toBe('hit');
    const s = scoreIgla(E); expect(s.rules).not.toContain('I5'); expect(s.metrics.hits).toBe(1);
  });
  it('the seeker holds the lock within its gimbal while the launcher is lifted ahead, and drops it beyond', () => {
    const { E, T } = single('male', 3000, 1200);
    run(E, 1, () => [{ k: 'raise', on: true }]); step(E, [{ k: 'power' }]);
    run(E, IGLA.readySec + 1);
    expect(E.lch.seeker).toBe('lock');
    const el0 = E.sol.el;
    step(E, [{ k: 'look', az: E.sol.az, el: el0 + IGLA.gimbalDeg - 2 }]); expect(E.lch.seeker).toBe('lock');
    step(E, [{ k: 'look', az: E.sol.az, el: el0 + IGLA.gimbalDeg + 4 }]);
    expect(iOffBore(E, T.p)).toBeGreaterThan(IGLA.gimbalDeg); expect(E.lch.seeker).toBe('search');
    expect(E.ev.some((e) => e.k === 'lockLost')).toBe(true);
  });
  it('reload drill: the gripstock goes on a fresh tube first, then a fresh BCU; the time is scored', () => {
    const { E, T } = single('tacIsr', 2000, 300);
    run(E, 10, shooter(T));
    expect(E.launches.length).toBe(1);
    step(E, [{ k: 'bcu' }]); expect(E.ev[E.ev.length - 1]).toMatchObject({ k: 'bcuFail', text: 'tube' });
    step(E, [{ k: 'reload' }]); run(E, IGLA.tubeSwapSec + 0.2);
    expect(E.lch.tube).toBe('live');
    step(E, [{ k: 'bcu' }]); run(E, IGLA.bcuFitSec + 0.2);
    expect(E.lch).toMatchObject({ tube: 'live', bcu: 'fitted', tubes: IGLA.tubes - 2 });
    const r = E.ev.find((e) => e.k === 'reloaded')!;
    expect(r.n).toBeGreaterThanOrEqual(IGLA.tubeSwapSec + IGLA.bcuFitSec); expect(r.n).toBeLessThanOrEqual(IGLA.reloadStdSec);
  });
  it('missile discipline: a missile at an FPV costs I2; at a friendly aircraft, I9 (−30)', () => {
    const a = single('fpv', 560, 60); run(a.E, 12, shooter(a.T, false));
    expect(a.E.launches.length).toBe(1);
    const sa = scoreIgla(a.E); expect(sa.rules).toContain('I2'); expect(sa.parts.find((p) => p.rule === 'I2')!.pts).toBe(10);
    const b = single('friendly', 2000, 250); run(b.E, 12, shooter(b.T));
    expect(b.E.launches.length).toBe(1);
    const sb = scoreIgla(b.E); expect(sb.rules).toContain('I9'); expect(sb.deductions[0].pts).toBe(-30);
  });
  it('an FPV hunting a gunner in the open strikes him; behind a building it loses him', () => {
    let struckIdle = 0, struckExpert = 0;
    for (let seed = 1; seed <= 6; seed++) {
      for (const expert of [false, true]) {
        const E = createIgla(defaultIglaCfg({ seed, difficulty: 2 }), W), s0 = E.spawns.find((s) => s.goal === 'hunt')!;
        E.spawns = [{ ...s0, t: 1 }];
        while (E.tick < 2000 && !E.sol.struck && !E.targets.some((t) => t.state !== 'live')) step(E, expert ? iglaAI(E) : []);
        if (E.sol.struck) { if (expert) struckExpert++; else struckIdle++; }
      }
    }
    expect(struckIdle).toBeGreaterThanOrEqual(3); expect(struckExpert).toBe(0);
  });
  it('the expert gunner: identifies, fires only at targets worth a missile, leads, reloads, takes cover', () => {
    const tot: number[] = [];
    for (const d of [1, 3, 5]) for (let seed = 1; seed <= 6; seed++) {
      const { E } = play(seed, { difficulty: d, time: seed % 3 ? 'day' : 'night', weather: seed % 4 ? 'clear' : 'rain' }), s = scoreIgla(E);
      tot.push(s.total);
      expect(E.launches.every((l) => l.value === 'high')).toBe(true);
      expect(E.sol.struck).toBe(false);
      expect(s.rules).not.toContain('I2'); expect(s.rules).not.toContain('I9');
    }
    const avg = tot.reduce((a, b) => a + b, 0) / tot.length;
    expect(Math.min(...tot)).toBeGreaterThanOrEqual(75); expect(avg).toBeGreaterThanOrEqual(90);
    console.log(`EVIDENCE igla expert: ${tot.length} drills (levels 1, 3, 5; day and night; clear and rain), average ${avg.toFixed(1)}, lowest ${Math.min(...tot)}`);
  });
  it('is deterministic: the action log replays to the same drill and score', () => {
    const { E, log } = play(5, { difficulty: 3 });
    const R = runIgla(defaultIglaCfg({ seed: 5, difficulty: 3 }), W, { actions: log });
    expect(R.tick).toBe(E.tick); expect(scoreIgla(R)).toEqual(scoreIgla(E));
    expect(R.missiles.map((m) => m.state)).toEqual(E.missiles.map((m) => m.state));
  });
  it('rules I1–I9 are all described', () => { expect(Object.keys(IGLA_RULES)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9']); });
});
