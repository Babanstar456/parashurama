import { describe, expect, it } from 'vitest';
import { closestApproach, defaultConfig, fly, gauss, gunsOf, losOf, muzzleVelocity, solveAim, type Ammo, type Met, type Vec3 } from '../src';

const G = gunsOf(defaultConfig), am = G.ammo.hei;
const met: Met = { tempC: 15, pressureHpa: 1013.25, wind: [0, 0, 0], latitudeDeg: 26 };
const at = (R: number, h = 300): Vec3 => [0, Math.sqrt(R * R - h * h), h];
const MIL = 1000 * Math.PI / 180; // mil per degree

describe('exterior ballistics (point mass, RK4)', () => {
  it('with no drag it matches the vacuum closed form', () => {
    const vac: Ammo = { ...am, cdMach: [[0, 0], [5, 0]] };
    let z = 0, y = 0;
    fly(vac, { az: 0, el: 45, mv: 500 }, { ...met, latitudeDeg: 0 }, { tMax: 10, dt: 0.01 }, (_t, p) => { z = p[2]; y = p[1]; });
    expect(z).toBeCloseTo(500 * Math.SQRT1_2 * 10 - 0.5 * 9.80665 * 100, 0);
    expect(y).toBeCloseTo(500 * Math.SQRT1_2 * 10, 0);
  });
  it('time of flight and superelevation grow with range; drag slows the round', () => {
    const rows = [1000, 1500, 2000].map((R) => { const s = solveAim(am, am.mv, met, at(R), [0, 0, 0]); return { R, tof: s.tof, sup: (s.el - losOf(at(R)).el) * MIL }; });
    expect(rows[0].tof).toBeLessThan(rows[1].tof); expect(rows[1].tof).toBeLessThan(rows[2].tof);
    expect(rows[0].sup).toBeLessThan(rows[1].sup); expect(rows[1].sup).toBeLessThan(rows[2].sup);
    expect(rows[2].tof).toBeGreaterThan(2000 / am.mv); // slower than the muzzle velocity on average
    console.log(`EVIDENCE gun time of flight / superelevation, 23 mm HEI-T (training values): ${rows.map((r) => `${r.R} m ${r.tof.toFixed(2)} s ${r.sup.toFixed(1)} mil`).join('; ')}`);
  });
  it('the lead on a crossing target is about speed × time of flight, and the solved shot hits', () => {
    const p: Vec3 = [0, 1470, 300], v: Vec3 = [30, 0, 0];
    const s = solveAim(am, am.mv, met, p, v);
    const leadDeg = s.az, expected = (30 * s.tof / 1500) * 180 / Math.PI;
    expect(Math.abs(leadDeg - expected) / expected).toBeLessThan(0.05);
    const ap = closestApproach(am, { az: s.az, el: s.el, mv: am.mv }, met, (t) => [p[0] + v[0] * t, p[1] + v[1] * t, p[2] + v[2] * t], 8);
    expect(ap.miss).toBeLessThan(0.1);
    console.log(`EVIDENCE gun lead for a 30 m/s crossing target at about 1,500 m: ${leadDeg.toFixed(2)}° (speed × time of flight gives ${expected.toFixed(2)}°), solved shot misses by ${ap.miss.toFixed(3)} m`);
  });
  it('a crosswind pushes the round downwind, and the solver allows for it', () => {
    const shot = { az: 0, el: 5, mv: am.mv }, target = (): Vec3 => [0, 1500, 130];
    const calm = closestApproach(am, shot, met, target, 6), windy = closestApproach(am, shot, { ...met, wind: [10, 0, 0] }, target, 6);
    expect(windy.point[0]).toBeGreaterThan(calm.point[0] + 0.5);
    const s = solveAim(am, am.mv, { ...met, wind: [10, 0, 0] }, target(), [0, 0, 0]);
    expect(s.az).toBeGreaterThan(300); // aims into the wind (west of north)
  });
  it('warm propellant shoots faster and flatter; thin hot air has less drag', () => {
    expect(muzzleVelocity(am, 40)).toBeGreaterThan(muzzleVelocity(am, 0));
    const hot = solveAim(am, muzzleVelocity(am, 40), { ...met, tempC: 40, pressureHpa: 950 }, at(1500), [0, 0, 0]);
    const cold = solveAim(am, muzzleVelocity(am, 0), { ...met, tempC: 0, pressureHpa: 1030 }, at(1500), [0, 0, 0]);
    expect(hot.tof).toBeLessThan(cold.tof);
  });
  it('seeded dispersion is repeatable and roughly standard normal', () => {
    expect(gauss(5, 9)).toBe(gauss(5, 9));
    const xs = Array.from({ length: 4000 }, (_, i) => gauss(77, i)), m = xs.reduce((a, b) => a + b) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
    expect(Math.abs(m)).toBeLessThan(0.06); expect(Math.abs(sd - 1)).toBeLessThan(0.06);
  });
});
