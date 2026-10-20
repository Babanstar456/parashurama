import { describe, expect, it } from 'vitest';
import {
  controlRoomAI, createGun, defaultConfig, defaultGunCfg, driveGun, gunCrewAI, gunMastery, gunsOf, observeGun, runGun, scoreControl, scoreGround,
  scoreReload, stepGun, unexploded, validateConfig, type Config, type GunAction, type GunDrillConfig, type GunEngine, type GunRecord,
} from '../src';

const crew = (E: GunEngine) => gunCrewAI(E);
const play = (cfg: GunDrillConfig, policies = [controlRoomAI, crew]) => { const E = createGun(cfg); const log = driveGun(E, policies); return { E, log }; };
/** Wraps a crew policy: drop or add actions to make a careless trainee. */
const tweak = (f: (E: GunEngine, acts: GunAction[]) => GunAction[]) => (E: GunEngine) => f(E, crew(E));

describe('gun drill engine', () => {
  it('is deterministic: replaying the log reproduces the live drill exactly', () => {
    for (const gun of ['zu23', 'zsu234']) for (const seed of [11, 12, 13]) {
      const cfg = defaultGunCfg({ seed, gun, difficulty: 4 }), { E, log } = play(cfg);
      const R = runGun(cfg, { actions: log, until: E.tick });
      expect(R.rounds.length).toBe(E.rounds.length);
      expect(JSON.stringify(R.targets)).toBe(JSON.stringify(E.targets));
      expect(scoreGround(R).total).toBe(scoreGround(E).total);
      expect(scoreControl(R).total).toBe(scoreControl(E).total);
    }
  });
  it('the expert crew and control room pass most drills on both guns', () => {
    const totals: number[] = [];
    for (const gun of ['zu23', 'zsu234']) for (let seed = 1; seed <= 8; seed++) {
      const { E } = play(defaultGunCfg({ seed, gun, difficulty: 3 }));
      totals.push(scoreGround(E).total, scoreControl(E).total);
      expect(scoreGround(E).deductions.every((d) => d.pts === 0)).toBe(true);
      expect(scoreControl(E).deductions.every((d) => d.pts === 0)).toBe(true);
    }
    const pass = defaultConfig.training.certification.passMark;
    expect(totals.filter((t) => t >= pass).length / totals.length).toBeGreaterThanOrEqual(0.75);
  });
  it('the shipped config is valid and an older config without guns.json still validates', () => {
    expect(validateConfig(defaultConfig).ok).toBe(true);
    const old = JSON.parse(JSON.stringify(defaultConfig)) as Config; delete old.guns;
    expect(validateConfig(old).ok).toBe(true);
    expect(gunsOf(old).guns.zu23).toBeDefined();
  });
});

describe('On Ground scoring (G rules)', () => {
  it('G1: firing without the executive order loses points but does not end the drill', () => {
    const cfg = defaultGunCfg({ seed: 21, difficulty: 2 });
    // Trigger-happy: safety off and fire as soon as the target is indicated, before FIRE.
    const happy = tweak((E, acts) => {
      const ind = E.cleared == null && E.orders.some((o) => o.o === 'target');
      return ind && E.g.loaded && E.g.layCid == null && !E.g.trig ? [...acts, { tick: E.tick, seat: 'gun', k: 'safety', on: false }, { tick: E.tick, seat: 'gun', k: 'trig', on: true }] : acts;
    });
    const good = scoreGround(play(cfg).E), bad = scoreGround(play(cfg, [controlRoomAI, happy]).E);
    const g1 = bad.deductions.find((d) => d.rule === 'G1')!;
    expect(g1.pts).toBeLessThan(0);
    expect(g1.why.join()).toMatch(/without clearance/);
    expect(bad.total).toBeLessThan(good.total);
    expect(bad.metrics.violations).toBeGreaterThan(0);
  });
  it('G10 / F4: firing into a safe arc loses points (on the gun and for the order)', () => {
    const base = defaultGunCfg({ seed: 22, difficulty: 2 });
    const { E } = play(base);
    const b = E.bursts.find((x) => x.authorised)!;
    const az = Math.round(E.rounds.find((r) => r.tick === b.start)!.az);
    const cfg: GunDrillConfig = { ...base, safeArcs: [[(az + 340) % 360, (az + 20) % 360]] };
    // Seats that ignore the safe arc (they see the drill without it); scoring uses the real one.
    const blind = (f: (x: GunEngine) => GunAction[]) => (x: GunEngine) => f({ ...x, cfg: base } as GunEngine);
    const R = runGun(cfg, { policies: [blind(controlRoomAI), blind(crew)], stopWhenDone: true });
    expect(scoreGround(R).deductions.find((d) => d.rule === 'G10')!.pts).toBeLessThan(0);
    expect(scoreControl(R).deductions.find((d) => d.rule === 'F4')!.pts).toBeLessThan(0);
    // The expert seats respect it: no deductions.
    const ok = runGun(cfg, { policies: [controlRoomAI, crew], stopWhenDone: true });
    expect(scoreGround(ok).deductions.every((d) => d.pts === 0)).toBe(true);
  });
  it('G5: a manual sight left at zero speed loses the ballistic-solution points', () => {
    const cfg = defaultGunCfg({ seed: 23, difficulty: 2 });
    const lazy = tweak((_E, acts) => acts.map((a) => (a.k === 'sight' ? { ...a, spd: 0, crs: 0 } : a)));
    const good = scoreGround(play(cfg).E), bad = scoreGround(play(cfg, [controlRoomAI, lazy]).E);
    const p = (s: typeof good) => s.parts.find((x) => x.rule === 'G5')!.pts;
    expect(p(bad)).toBeLessThan(p(good));
  });
  it('Air Defence Warning YELLOW: the crew must man the gun before it can load', () => {
    const E = createGun(defaultGunCfg({ seed: 24, adw: 'yellow' }));
    stepGun(E, [{ tick: 0, seat: 'cr', k: 'order', o: 'rangeClear' }, { tick: 0, seat: 'gun', k: 'load' }]);
    expect(E.g.busy).toBeNull();
    const { E: F } = play(defaultGunCfg({ seed: 24, adw: 'yellow' }));
    expect(F.ev.some((e) => e.k === 'posted')).toBe(true);
  });
});

describe('Control Room scoring (F rules)', () => {
  it('F3: ordering fire on a friendly or civil aircraft loses 40 points', () => {
    const cfg = defaultGunCfg({ seed: 31, difficulty: 3 });
    const { E } = play(cfg);
    const nh = E.targets.find((t) => !t.hostile)!;
    expect(nh).toBeDefined();
    const bad = (x: GunEngine): GunAction[] => (x.tick === nh.spawnTick + 20 ? [{ tick: x.tick, seat: 'cr', k: 'order', o: 'engage', cid: nh.id }] : controlRoomAI(x));
    const sc = scoreControl(play(cfg, [bad, crew]).E);
    expect(sc.deductions.find((d) => d.rule === 'F3')!.pts).toBeLessThanOrEqual(-40);
  });
  it('F3: under WEAPONS HOLD the expert waits for self-defence range; ordering earlier loses points', () => {
    const cfg = defaultGunCfg({ seed: 32, difficulty: 2, wcs: 'hold' });
    expect(scoreControl(play(cfg).E).deductions.find((d) => d.rule === 'F3')!.pts).toBe(0);
    const eager = (x: GunEngine): GunAction[] => controlRoomAI({ ...x, cfg: { ...x.cfg, wcs: 'tight' } } as GunEngine);
    expect(scoreControl(play(cfg, [eager, crew]).E).deductions.find((d) => d.rule === 'F3')!.pts).toBeLessThan(0);
  });
  it('F2: an executive order without Target and Method loses sequence points', () => {
    const cfg = defaultGunCfg({ seed: 33, difficulty: 2 });
    const skip = (x: GunEngine) => controlRoomAI(x).filter((a) => a.o !== 'method');
    const p = (E: GunEngine) => scoreControl(E).parts.find((x) => x.rule === 'F2')!.pts;
    expect(p(play(cfg, [skip, crew]).E)).toBeLessThan(p(play(cfg).E));
  });
});

describe('gun skills and evidence', () => {
  it('observations go only to the game played; mastery stays in [0,1]', () => {
    const { E } = play(defaultGunCfg({ seed: 41 }));
    const g = scoreGround(E), c = scoreControl(E);
    expect(Object.keys(observeGun(g)).every((k) => k.startsWith('g'))).toBe(true);
    expect(Object.keys(observeGun(c)).every((k) => k.startsWith('f'))).toBe(true);
    const H: GunRecord[] = [{ n: 1, game: 'ground', cfg: E.cfg, total: g.total, obs: observeGun(g), metrics: g.metrics, rules: g.rules, endTick: E.tick }];
    for (const v of Object.values(gunMastery(H))) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });
  it('EVIDENCE: manual sight (ZU-23-2) against radar fire control (ZSU-23-4), expert crews', () => {
    const row = (gun: string) => {
      let kills = 0, hostiles = 0, rounds = 0, total = 0;
      for (let seed = 101; seed <= 110; seed++) { const s = scoreGround(play(defaultGunCfg({ seed, gun, difficulty: 3 })).E); kills += s.metrics.kills; hostiles += s.metrics.hostiles; rounds += s.metrics.roundsFired; total += s.total; }
      return { kills, hostiles, perKill: kills ? Math.round(rounds / kills) : null, avg: Math.round(total / 10) };
    };
    const zu = row('zu23'), zsu = row('zsu234');
    expect(zsu.kills).toBeGreaterThanOrEqual(zu.kills);
    console.log(`EVIDENCE gun expert crews, 10 drills each: ZU-23-2 manual sight ${zu.kills}/${zu.hostiles} destroyed, ${zu.perKill} rounds per kill, average ${zu.avg}; ZSU-23-4 radar ${zsu.kills}/${zsu.hostiles}, ${zsu.perKill} rounds per kill, average ${zsu.avg}`);
  });
});

describe('reload drill (G12) and live-fire procedure (L1–L3)', () => {
  it('reload steps must go in order; a step out of order is counted and costs credit', () => {
    const E = createGun(defaultGunCfg({ seed: 51 }));
    const R = E.gun.reload!;
    stepGun(E, [{ tick: 0, seat: 'gun', k: 'rstep', item: R[1].id }]); // wrong first step
    expect(E.reloads[0].errors).toBe(1);
    expect(E.g.busy).toBeNull();
  });
  it('reload practice: the expert does three reloads to the standard; a fumbling trainee scores less', () => {
    const cfg = defaultGunCfg({ seed: 52, practice: 'reload' });
    const { E } = play(cfg, [crew]);
    expect(E.reloads.filter((r) => r.end != null).length).toBe(3);
    const good = scoreReload(E).total;
    expect(good).toBeGreaterThanOrEqual(90);
    // Fumbler: tries the last step first on every reload.
    const fumble = tweak((x, acts) => (x.g.rIdx === 0 && !x.g.busy && !x.g.loaded && x.tick % 7 === 0 ? [{ tick: x.tick, seat: 'gun', k: 'rstep', item: x.gun.reload!.at(-1)!.id }, ...acts] : acts));
    const bad = scoreReload(play(cfg, [fumble]).E).total;
    expect(bad).toBeLessThan(good);
    console.log(`EVIDENCE reload drill (3 reloads, ZU-23-2): expert ${good}, steps out of order ${bad}`);
  });
  it('L1/L2/L3: skipping the gun checks, the range checks or the UXO sweep costs points', () => {
    const cfg = defaultGunCfg({ seed: 53, difficulty: 3 });
    const noGunChecks = tweak((_x, acts) => acts.filter((a) => a.k !== 'check'));
    const noRange = (x: GunEngine) => controlRoomAI(x).filter((a) => a.k !== 'check' && a.k !== 'uxo');
    const E = play(cfg, [noRange, noGunChecks]).E;
    const ded = (r: string, s: ReturnType<typeof scoreGround>) => s.deductions.find((d) => d.rule === r)!.pts;
    expect(ded('L1', scoreGround(E))).toBeLessThan(0);
    expect(ded('L2', scoreControl(E))).toBeLessThan(0);
    if (unexploded(E).length) expect(ded('L3', scoreControl(E))).toBeLessThan(0);
    const ok = play(cfg).E;
    expect(ded('L1', scoreGround(ok))).toBe(0); expect(ded('L2', scoreControl(ok))).toBe(0); expect(ded('L3', scoreControl(ok))).toBe(0);
  });
});
