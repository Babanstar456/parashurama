import { describe, expect, it } from 'vitest';
import {
  controlRoomAI, createGun, defaultConfig, defaultGunCfg, detectRangeM, driveGun, gunCrewAI, observeGun, planGun, runGun, scoreField, validateConfig,
  type Config, type GunAction, type GunDrillConfig, type GunEngine,
} from '../src';

/** Field drill (3D): the detachment finds, reports and identifies its own targets; V1–V3 plus the On Ground rules. */
const crew = (E: GunEngine) => gunCrewAI(E);
const field = (o: Partial<GunDrillConfig>) => defaultGunCfg({ difficulty: 4, selfId: true, ...o });
const play = (cfg: GunDrillConfig, gun = crew) => { const E = createGun(cfg); const log = driveGun(E, [controlRoomAI, gun]); return { E, log }; };
const tweak = (f: (E: GunEngine, acts: GunAction[]) => GunAction[]) => (E: GunEngine) => f(E, crew(E));

describe('field drill (V rules)', () => {
  it('is deterministic on all three guns: replaying the log reproduces the drill and the score', () => {
    for (const gun of ['zu23', 'zsu234', 'l70']) for (const seed of [3, 4]) {
      const cfg = field({ seed, gun, terrain: 'urban', weather: 'rain' }), { E, log } = play(cfg);
      const R = runGun(cfg, { actions: log, until: E.tick });
      expect(JSON.stringify(R.targets)).toBe(JSON.stringify(E.targets));
      expect(R.idents).toEqual(E.idents);
      expect(scoreField(R).total).toBe(scoreField(E).total);
    }
  });
  it('field drill: three hostiles, one friendly aircraft and a bird; it ends once the last hostile is down', () => {
    for (const seed of [1, 2, 3]) {
      const { E } = play(field({ seed, gun: 'l70' }));
      const T = defaultConfig.threats.threats;
      expect(E.spawns.filter((s) => T[s.type].hostile).length).toBe(3);
      expect(E.spawns.filter((s) => s.type === 'friendly').length).toBe(1);
      expect(E.spawns.filter((s) => s.type === 'bird').length).toBe(1);
      const last = Math.max(...E.targets.filter((t) => t.hostile).map((t) => t.endTick ?? Infinity));
      expect(E.targets.filter((t) => t.hostile).every((t) => t.state !== 'live')).toBe(true);
      expect(E.tick - last).toBeLessThanOrEqual(31);
    }
  });
  it('the L70 holds one 4-round clip; the loader drops in the next one', () => {
    const { E } = play(field({ seed: 2, gun: 'l70' }));
    expect(E.gun.beltRounds).toBe(4);
    expect(E.reloads.filter((r) => r.end != null).length).toBeGreaterThanOrEqual(2);
  });
  it('mixes swarms, birds, civil and friendly traffic into the threats', () => {
    const E = createGun(field({ seed: 4, swarm: true }));
    const types = E.spawns.map((s) => s.type);
    expect(types.filter((t) => t === 'swarm').length).toBeGreaterThanOrEqual(3);
    expect(types).toContain('bird'); expect(types).toContain('friendly');
  });
  it('the expert detachment never breaks fire discipline and passes most drills, day and night, urban and rural', () => {
    const totals: number[] = [];
    for (const gun of ['zu23', 'zsu234', 'l70']) for (const [time, terrain] of [['day', 'rural'], ['day', 'urban'], ['night', 'rural']] as const) {
      if (gun === 'zu23' && time === 'night') continue; // the planner tasks the thermal or radar gun at night
      for (let seed = 1; seed <= 5; seed++) {
        const s = scoreField(play(field({ seed, gun, time, terrain })).E);
        expect(s.deductions.every((d) => d.pts === 0)).toBe(true);
        totals.push(s.total);
      }
    }
    const pass = defaultConfig.training.certification.passMark;
    expect(totals.filter((t) => t >= pass).length / totals.length).toBeGreaterThanOrEqual(0.85);
  });
  it('V1: a detachment that never reports contacts loses detection, identification and the kills', () => {
    const cfg = field({ seed: 2, gun: 'l70' });
    const blind = tweak((_E, acts) => acts.filter((a) => a.k !== 'spot' && a.k !== 'ident'));
    const good = scoreField(play(cfg).E), bad = scoreField(play(cfg, blind).E);
    const pts = (s: typeof good, r: string) => s.parts.find((p) => p.rule === r)!.pts;
    expect(pts(bad, 'V1')).toBe(0); expect(pts(bad, 'V2')).toBe(0);
    expect(bad.metrics.kills).toBe(0);
    expect(good.total - bad.total).toBeGreaterThan(40);
  });
  it('V2: calling a friendly UAV hostile costs the identification; the control room still catches it on its air picture and holds fire', () => {
    const cfg = field({ seed: 6, gun: 'l70', difficulty: 3 });
    const wrong = tweak((E, acts) => acts.map((a) => (a.k === 'ident' && E.targets.find((t) => t.id === a.cid)?.type === 'friendly' ? { ...a, cls: 'loiter' } : a)));
    const E = play(cfg, wrong).E, s = scoreField(E), good = scoreField(play(cfg).E);
    expect(E.targets.some((t) => t.type === 'friendly')).toBe(true);
    expect(s.why.some((w) => w.startsWith('V2:') && w.includes('Friendly UAV'))).toBe(true);
    expect(E.bursts.some((b) => E.targets.find((t) => t.id === b.cid)?.type === 'friendly')).toBe(false);
    expect(s.total).toBeLessThan(good.total);
  });
  it('V3/G1: firing on the friendly aircraft costs the decision and 40 points', () => {
    const cfg = field({ seed: 6, gun: 'l70', difficulty: 3 });
    // Trigger-happy layer: locks on the civil drone, takes the safety off and fires, clearance or not.
    const rogue = tweak((E, acts) => {
      const F = E.targets.find((t) => t.type === 'friendly' && t.state === 'live' && E.spots[t.id] != null);
      if (!F || !E.g.loaded || E.bursts.some((b) => b.cid === F.id)) return acts;
      const keep = acts.filter((a) => !['lay', 'slew', 'trig', 'safety', 'lock'].includes(a.k));
      const out: GunAction[] = [...keep, ...(E.g.lockCid !== F.id ? [{ tick: E.tick, seat: 'gun', k: 'lock', cid: F.id } as GunAction] : [])];
      if (E.g.safety) out.push({ tick: E.tick, seat: 'gun', k: 'safety', on: false } as GunAction);
      if (E.g.lockCid === F.id && E.fcs?.ok && Math.hypot(E.fcs.az - E.g.az, E.fcs.el - E.g.el) < 0.5) out.push({ tick: E.tick, seat: 'gun', k: 'trig', on: true } as GunAction);
      return out;
    });
    const s = scoreField(play(cfg, rogue).E);
    expect(s.deductions.find((d) => d.rule === 'G1')!.pts).toBeLessThanOrEqual(-40);
    expect(s.parts.find((p) => p.rule === 'V3')!.pts).toBeLessThan(10);
  });
  it('V2: unknown is a legitimate answer that earns partial credit and can be upgraded', () => {
    const cfg = field({ seed: 2, gun: 'zsu234' });
    const unsure = tweak((_E, acts) => acts.map((a) => (a.k === 'ident' ? { ...a, cls: 'unknown' } : a)));
    const s = scoreField(play(cfg, unsure).E), v2 = s.parts.find((p) => p.rule === 'V2')!;
    expect(v2.pts).toBeGreaterThan(0); expect(v2.pts).toBeLessThan(v2.max / 2);
  });
  it('detection is shorter at night, in fog and in towns; the thermal sight sees further than the eye at night', () => {
    const range = (o: Partial<GunDrillConfig>) => { const E = createGun(field({ seed: 1, ...o })); const T = { id: 1, type: 'fpv', hostile: true } as any; return detectRangeM(E, T); };
    expect(range({ gun: 'zu23', time: 'night' })).toBeLessThan(range({ gun: 'zu23' }));
    expect(range({ gun: 'zu23', weather: 'fog' })).toBeLessThan(range({ gun: 'zu23' }));
    expect(range({ gun: 'zu23', terrain: 'urban' })).toBeLessThan(range({ gun: 'zu23' }));
    expect(range({ gun: 'l70', time: 'night' })).toBeGreaterThan(range({ gun: 'zu23', time: 'night' }));
    expect(range({ gun: 'l70', time: 'night', radarFault: true })).toBe(range({ gun: 'zu23', time: 'night' }));
  });
  it('planner: field drills use all three guns, set selfId, and never give the manual-sight gun a night drill', () => {
    const guns = new Set<string>();
    let H: any[] = [];
    for (let i = 0; i < 40; i++) {
      const p = planGun(H, 'field');
      expect(p.cfg.selfId).toBe(true);
      if (p.cfg.time === 'night') expect(p.cfg.gun).not.toBe('zu23');
      guns.add(p.cfg.gun);
      const s = scoreField(play(p.cfg).E);
      H = [...H, { n: i + 1, game: 'field', cfg: p.cfg, total: s.total, obs: observeGun(s), metrics: s.metrics, rules: s.rules, endTick: 0 }];
      if (guns.size === 3) break;
    }
    expect(guns.size).toBe(3);
  });
  it('a config without the detect block or the V rules still validates (field drill falls back to the shipped values)', () => {
    const old = JSON.parse(JSON.stringify(defaultConfig)) as Config;
    delete old.guns!.detect; for (const r of ['V1', 'V2', 'V3']) delete old.doctrine.rules[r];
    expect(validateConfig(old).ok).toBe(true);
    expect(scoreField(play(field({ seed: 1, gun: 'l70' })).E).total).toBeGreaterThan(0);
  });
  it('EVIDENCE: field drill, expert detachment on each gun (10 drills each, difficulty 4, mixed conditions)', () => {
    const conds = [['day', 'rural', 'clear'], ['day', 'urban', 'clear'], ['day', 'urban', 'rain'], ['night', 'rural', 'clear'], ['day', 'rural', 'dust']] as const;
    const row = (gun: string) => {
      let kills = 0, hostiles = 0, total = 0, n = 0;
      for (let seed = 201; seed <= 210; seed++) {
        const [time, terrain, weather] = conds[seed % conds.length];
        const s = scoreField(play(field({ seed, gun, time: gun === 'zu23' ? 'day' : time, terrain, weather })).E);
        kills += s.metrics.kills; hostiles += s.metrics.hostiles; total += s.total; n++;
      }
      return `${kills}/${hostiles} destroyed, average ${Math.round(total / n)}`;
    };
    const zu = row('zu23'), zsu = row('zsu234'), l70 = row('l70');
    console.log(`EVIDENCE field drill expert detachment, 10 drills each: ZU-23-2 manual sight ${zu}; ZSU-23-4 radar ${zsu}; L70 thermal sight ${l70}`);
  });
});
