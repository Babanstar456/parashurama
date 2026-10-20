import type { Ammo } from './config';
import { hash2 } from './util';

/**
 * Exterior ballistics for the gun detachment: point-mass (3-DOF) model integrated with RK4 at a fixed step.
 * Forces: gravity, aerodynamic drag (drag coefficient against Mach from guns.json), wind, and the Coriolis effect.
 * Air: the standard-atmosphere lapse rate from the site's measured temperature and pressure.
 * Frame: x east, y north, z up (metres), origin at the gun. Azimuth in degrees clockwise from north; elevation up from level.
 * Pure and deterministic (no Math.random). Training values, not a firing table for real equipment.
 */
export type Vec3 = [number, number, number];
export interface Met { tempC: number; pressureHpa: number; wind: Vec3; latitudeDeg: number; }
export interface Shot { az: number; el: number; mv: number; }

const G0 = 9.80665, RAIR = 287.05, LAPSE = 0.0065, GAMMA = 1.4, OMEGA = 7.2921e-5;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export const dirOf = (az: number, el: number): Vec3 => {
  const a = az * D2R, e = el * D2R, c = Math.cos(e);
  return [Math.sin(a) * c, Math.cos(a) * c, Math.sin(e)];
};
/** Azimuth/elevation (deg) and slant range (m) of a point seen from the gun. */
export const losOf = (p: Vec3): { az: number; el: number; range: number } => {
  const h = Math.hypot(p[0], p[1]);
  return { az: ((Math.atan2(p[0], p[1]) * R2D) + 360) % 360, el: Math.atan2(p[2], h) * R2D, range: Math.hypot(h, p[2]) };
};
/** Smallest signed angle difference a − b in degrees (−180, 180]. */
export const angDiff = (a: number, b: number): number => { const d = ((a - b) % 360 + 540) % 360 - 180; return d === -180 ? 180 : d; };

/** Air density (kg/m³) and speed of sound (m/s) at height z above the gun, from the measured ground temperature and pressure. */
export function atmosphere(met: Met, z: number): { rho: number; a: number } {
  const T0 = met.tempC + 273.15, T = Math.max(150, T0 - LAPSE * z);
  const P = met.pressureHpa * 100 * Math.pow(T / T0, G0 / (LAPSE * RAIR));
  return { rho: P / (RAIR * T), a: Math.sqrt(GAMMA * RAIR * T) };
}
/** Drag coefficient at a Mach number: linear interpolation in the ammo's table, held flat beyond its ends. */
export function cdAt(am: Ammo, mach: number): number {
  const t = am.cdMach;
  if (mach <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (mach <= t[i][0]) { const [m0, c0] = t[i - 1], [m1, c1] = t[i]; return c0 + (c1 - c0) * (mach - m0) / (m1 - m0); }
  return t[t.length - 1][1];
}
/** Muzzle velocity for this ammo at a propellant temperature (warm charges shoot faster). */
export const muzzleVelocity = (am: Ammo, tempC: number, stdTempC = 15): number => am.mv + (tempC - stdTempC) * am.mvPerDegC;

function accel(am: Ammo, met: Met, k: number, cor: Vec3, p: Vec3, v: Vec3, out: Vec3): void {
  const { rho, a } = atmosphere(met, p[2]);
  const rx = v[0] - met.wind[0], ry = v[1] - met.wind[1], rz = v[2] - met.wind[2];
  const vr = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const d = k * rho * cdAt(am, vr / a) * vr; // drag per unit relative velocity
  // Coriolis: −2 Ω × v, with Ω = ω (0, cos φ, sin φ) in east-north-up.
  out[0] = -d * rx - 2 * (cor[1] * v[2] - cor[2] * v[1]);
  out[1] = -d * ry - 2 * (cor[2] * v[0] - cor[0] * v[2]);
  out[2] = -d * rz - G0 - 2 * (cor[0] * v[1] - cor[1] * v[0]);
}

export interface FlyOpts { dt?: number; tMax: number; }
/**
 * Fly one round with RK4. `visit(t, p, v)` is called after every step; return true to stop.
 * Returns the last time, position and velocity.
 */
export function fly(am: Ammo, shot: Shot, met: Met, o: FlyOpts, visit?: (t: number, p: Vec3, v: Vec3) => boolean | void): { t: number; p: Vec3; v: Vec3 } {
  const dt = o.dt ?? 0.005, k = (0.5 * Math.PI * am.caliberM * am.caliberM / 4) / am.massKg;
  const ph = met.latitudeDeg * D2R, cor: Vec3 = [0, OMEGA * Math.cos(ph), OMEGA * Math.sin(ph)];
  const u = dirOf(shot.az, shot.el);
  let p: Vec3 = [0, 0, 0], v: Vec3 = [u[0] * shot.mv, u[1] * shot.mv, u[2] * shot.mv], t = 0;
  const a1: Vec3 = [0, 0, 0], a2: Vec3 = [0, 0, 0], a3: Vec3 = [0, 0, 0], a4: Vec3 = [0, 0, 0];
  const pt: Vec3 = [0, 0, 0], vt: Vec3 = [0, 0, 0];
  while (t < o.tMax - 1e-9) {
    accel(am, met, k, cor, p, v, a1);
    for (let i = 0; i < 3; i++) { pt[i] = p[i] + v[i] * dt / 2; vt[i] = v[i] + a1[i] * dt / 2; }
    const v2: Vec3 = [vt[0], vt[1], vt[2]];
    accel(am, met, k, cor, pt, v2, a2);
    for (let i = 0; i < 3; i++) { pt[i] = p[i] + v2[i] * dt / 2; vt[i] = v[i] + a2[i] * dt / 2; }
    const v3: Vec3 = [vt[0], vt[1], vt[2]];
    accel(am, met, k, cor, pt, v3, a3);
    for (let i = 0; i < 3; i++) { pt[i] = p[i] + v3[i] * dt; vt[i] = v[i] + a3[i] * dt; }
    const v4: Vec3 = [vt[0], vt[1], vt[2]];
    accel(am, met, k, cor, pt, v4, a4);
    const np: Vec3 = [0, 0, 0], nv: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      np[i] = p[i] + dt / 6 * (v[i] + 2 * v2[i] + 2 * v3[i] + v4[i]);
      nv[i] = v[i] + dt / 6 * (a1[i] + 2 * a2[i] + 2 * a3[i] + a4[i]);
    }
    p = np; v = nv; t += dt;
    if (visit && visit(t, p, v)) break;
  }
  return { t, p, v };
}

export interface Approach { miss: number; tau: number; point: Vec3; }
/**
 * Closest approach of a round to a moving target. `target(tau)` gives the target position `tau` seconds after the shot.
 * Between integration steps the relative motion is taken as linear, so the miss distance is resolved below one step.
 */
export function closestApproach(am: Ammo, shot: Shot, met: Met, target: (tau: number) => Vec3, tMax: number, dt = 0.005): Approach {
  let best: Approach = { miss: Infinity, tau: 0, point: [0, 0, 0] };
  const q0 = target(0);
  let prevT = 0, prevP: Vec3 = [0, 0, 0], prevRel: Vec3 = [-q0[0], -q0[1], -q0[2]]; // round minus target
  let growing = 0;
  fly(am, shot, met, { dt, tMax }, (t, p) => {
    const q = target(t), rel: Vec3 = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const d: Vec3 = [rel[0] - prevRel[0], rel[1] - prevRel[1], rel[2] - prevRel[2]];
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const s = dd > 0 ? Math.max(0, Math.min(1, -(prevRel[0] * d[0] + prevRel[1] * d[1] + prevRel[2] * d[2]) / dd)) : 0;
    const m = Math.hypot(prevRel[0] + d[0] * s, prevRel[1] + d[1] * s, prevRel[2] + d[2] * s);
    if (m < best.miss) {
      best = { miss: m, tau: prevT + (t - prevT) * s, point: [prevP[0] + (p[0] - prevP[0]) * s, prevP[1] + (p[1] - prevP[1]) * s, prevP[2] + (p[2] - prevP[2]) * s] };
      growing = 0;
    } else if (++growing > 40) return true; // clearly moving away: stop early
    prevT = t; prevP = p; prevRel = rel;
  });
  return best;
}

export interface AimSolution { az: number; el: number; tof: number; aim: Vec3; ok: boolean; }
/**
 * Fire-control solution against a target assumed to fly straight at constant velocity (what a sight or a fire-control
 * computer assumes): find the gun azimuth/elevation whose round meets the target. Fixed-point iteration on time of flight,
 * with angle corrections from simulated trajectories (so drag, wind, drop and Coriolis are all in the lead).
 * Pass the previous solution as `warm` to converge in one or two passes.
 */
export function solveAim(am: Ammo, mv: number, met: Met, p: Vec3, v: Vec3, warm?: AimSolution | null, iters = 6): AimSolution {
  let tof = warm?.ok ? warm.tof : losOf(p).range / mv;
  let az = 0, el = 0, aim: Vec3 = p, have = false;
  if (warm?.ok) { az = warm.az; el = warm.el; have = true; }
  for (let it = 0; it < iters; it++) {
    aim = [p[0] + v[0] * tof, p[1] + v[1] * tof, p[2] + v[2] * tof];
    const L = losOf(aim);
    if (!have) { az = L.az; el = L.el; have = true; }
    const fixed: Vec3 = aim;
    const ap = closestApproach(am, { az, el, mv }, met, () => fixed, Math.max(1, tof * 2 + 1), 0.01);
    const Q = losOf(ap.point);
    az = (az + angDiff(L.az, Q.az) + 360) % 360; el += L.el - Q.el;
    const dT = ap.tau - tof; tof = ap.tau;
    if (Math.abs(dT) < 1e-3 && Math.abs(L.el - Q.el) < 1e-4 && Math.abs(angDiff(L.az, Q.az)) < 1e-4) return { az, el, tof, aim, ok: true };
  }
  return { az, el, tof, aim, ok: Number.isFinite(tof) && tof > 0 };
}

/** Seeded standard normal draw from two integers (Box–Muller on hash2). */
export function gauss(a: number, b: number): number {
  const u1 = hash2(a, b) || 1e-12, u2 = hash2(a ^ 0x5bd1e995, b + 7919);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
