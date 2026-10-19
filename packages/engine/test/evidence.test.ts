// Evidence for the PS deliverables. Each test asserts a property and prints the measured figure as an `EVIDENCE …` line,
// so the numbers quoted in docs/TRACEABILITY.md come from a run, not from memory.
import { describe, expect, it } from 'vitest';
import {
  buildScenario, classificationStats, createEngine, demoHistory, drillsToCsv, expertPolicy, mastery, observe, planNext, runSim, runTotal,
  scoreRun, sectorOf, ticks, calStats, type Engine, type SessionRecord, type Spawn,
} from '../src';
import { baseCfg, C, controller, drive } from './helpers';

const ev = (k: string, v: unknown) => console.log(`EVIDENCE ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const MIX: Spawn[] = [{ type: 'recon', t: 0, brg: 30, dist: 2200 }, { type: 'fpv', t: 0, brg: 120, dist: 2600 }, { type: 'friendly', t: 0, brg: 210, dist: 2000 }, { type: 'bird', t: 0, brg: 300, dist: 1500 }];

// Three scripted trainees.
const disciplined = (E: Engine) => expertPolicy(E);
const triggerHappy = controller({ cls: () => 'fpv', conf: 0.95, eff: () => 'intc' }); // calls everything a hostile FPV and fires
const inattentive = () => [];                                                         // never tracks anything

function play(ctl: (E: Engine) => any[], spawns?: Spawn[], cfg = baseCfg()) {
  const E = createEngine(cfg, C, spawns);
  drive(E, ctl);
  const sc = scoreRun(E);
  return { E, sc, total: runTotal(sc), stats: classificationStats(sc, C) };
}
function record(E: Engine, n: number): SessionRecord {
  const sc = scoreRun(E);
  return { n, demo: false, cfg: E.cfg, total: runTotal(sc), obs: observe(E, sc), attn: new Array(12).fill(1 / 12), thr: new Array(12).fill(0), cal: calStats(sc, C), jamNoRF: 0 };
}

describe('evidence: randomisation (PS: drills cannot be learned by rote)', () => {
  it('100 seeds give 100 different drills covering every bearing sector', () => {
    const keys = new Set<string>(), mixes = new Set<string>(), sectors = new Set<number>();
    for (let s = 1; s <= 100; s++) {
      const sp = buildScenario(baseCfg({ seed: s, drill: s }), C);
      keys.add(JSON.stringify(sp));
      mixes.add(sp.map((x) => x.type).sort().join('+'));
      sp.forEach((x) => sectors.add(sectorOf(x.brg)));
    }
    ev('unique drills from 100 seeds', keys.size); ev('distinct threat mixes', mixes.size); ev('bearing sectors used (of 12)', sectors.size);
    expect(keys.size).toBe(100);
    expect(sectors.size).toBe(12);
    expect(mixes.size).toBeGreaterThan(1);
  });

  it('different trainee histories lead to different next drills', () => {
    const seeds = new Set<number>();
    for (let i = 0; i < 20; i++) seeds.add(planNext(demoHistory().map((s, j) => ({ ...s, total: 40 + i + j }))).cfg.seed);
    ev('distinct next seeds from 20 histories', seeds.size);
    expect(seeds.size).toBe(20);
  });
});

describe('evidence: scoring measures detection, classification and engagement (PS deliverable 2)', () => {
  it('detection time is measured from the first radar paint', () => {
    const { sc } = play(controller({ trackAfterPaintSec: 2, ignoreVisibility: true }), [{ type: 'recon', t: 0, brg: 90, dist: 2500 }]);
    ev('measured detection time for a 2 s delay (s)', sc[0].det?.toFixed(1));
    expect(sc[0].det).toBeCloseTo(2, 0);
  });

  it('a disciplined trainee identifies every contact with no false positives or misses', () => {
    const { stats, total } = play(disciplined, MIX);
    ev('disciplined trainee', { idRatePct: Math.round(stats.idRate * 100), falsePositives: stats.falsePositives, missedHostiles: stats.missedHostiles, total });
    expect(stats.falsePositives).toBe(0);
    expect(stats.missedHostiles).toBe(0);
    expect(stats.idRate).toBe(1);
  });

  it('a trigger-happy trainee is caught: wrong identifications and false positives', () => {
    const { stats, total } = play(triggerHappy, MIX);
    ev('trigger-happy trainee', { idRatePct: Math.round(stats.idRate * 100), falsePositives: stats.falsePositives, total });
    expect(stats.falsePositives).toBe(2); // the friendly UAV and the bird
    expect(stats.idRate).toBeLessThan(0.5);
  });

  it('an inattentive trainee misses every hostile and scores zero on them', () => {
    const { stats, sc } = play(inattentive, [{ type: 'fpv', t: 0, brg: 60, dist: 2500 }, { type: 'recon', t: 0, brg: 240, dist: 2500 }]);
    ev('inattentive trainee', `${stats.missedHostiles} of ${stats.hostiles} hostiles missed, scores ${sc.map((s) => s.total).join('/')}`);
    expect(stats.missedHostiles).toBe(stats.hostiles);
    expect(sc.every((s) => s.total === 0)).toBe(true);
  });
});

describe('evidence: repeated sessions separate trainees (PS deliverable 3)', () => {
  it('careful and careless trainees diverge over 3 sessions', () => {
    const run = (ctl: (E: Engine) => any[]) => [1, 2, 3].map((n) => { const E = createEngine(baseCfg({ seed: 500 + n, drill: n }), C, MIX); drive(E, ctl); return record(E, n); });
    const careful = run(disciplined), careless = run(triggerHappy);
    const mc = mastery(careful, C), ml = mastery(careless, C);
    ev('careful scores', careful.map((r) => r.total).join('/')); ev('careless scores', careless.map((r) => r.total).join('/'));
    ev('identification mastery careful vs careless (%)', `${Math.round(mc.identify * 100)} vs ${Math.round(ml.identify * 100)}`);
    careful.forEach((r, i) => expect(r.total).toBeGreaterThan(careless[i].total));
    expect(mc.identify).toBeGreaterThan(ml.identify);
  });
});

describe('evidence: adaptive difficulty (PS deliverable 4)', () => {
  const CONDS = ['night', 'swarm', 'degraded', 'weather'] as const;
  const histWithWeak = (weak: string): SessionRecord[] => demoHistory().map((s) => ({ ...s, obs: { ...s.obs, ...Object.fromEntries(CONDS.map((k) => [k, new Array(4).fill(k !== weak)])) } }));
  it('targets the weakest condition every time', () => {
    let hit = 0;
    for (const k of CONDS) {
      const cfg = planNext(histWithWeak(k)).cfg;
      if ((k === 'night' && cfg.time === 'night') || (k === 'swarm' && cfg.pattern === 'swarm') || (k === 'degraded' && cfg.fault !== 'none') || (k === 'weather' && cfg.weather !== 'clear')) hit++;
    }
    ev('weakest condition targeted', `${hit} of ${CONDS.length}`);
    expect(hit).toBe(CONDS.length);
  });

  it('difficulty follows recent performance', () => {
    const at = (totals: number[]) => planNext(demoHistory().slice(0, totals.length).map((s, i) => ({ ...s, total: totals[i] }))).cfg.difficulty;
    const good = at([90, 90, 90]), oneBad = at([90, 90, 30]);
    ev('one bad drill moves difficulty', `${good} -> ${oneBad}`);
    expect(good - oneBad).toBe(1);
    const lv = [90, 70, 40].map((v) => at([v, v, v]));
    ev('sustained averages 90 / 70 / 40 give levels', lv.join(' / '));
    expect(lv[0]).toBeGreaterThan(lv[1]); expect(lv[1]).toBeGreaterThan(lv[2]);
  });
});

describe('evidence: runs on ordinary computers', () => {
  it('the engine runs far faster than real time headless', () => {
    const cfg = baseCfg({ seed: 77, difficulty: 6 }), sec = C.training.sim.maxDrillSec;
    const t0 = performance.now(); runSim(cfg, { policy: expertPolicy }, C); const ms = performance.now() - t0;
    const factor = Math.round((sec * 1000) / ms);
    ev('headless speed (x real time)', factor);
    expect(factor).toBeGreaterThan(50);
    expect(ticks(C, sec)).toBeGreaterThan(0);
  });
});

describe('evidence: drill export', () => {
  it('exports drill history as CSV with one row per drill and safe cells', () => {
    const E = createEngine(baseCfg(), C, MIX); drive(E, disciplined);
    const sc = scoreRun(E), rec = { ...record(E, 1), date: 0, cls: classificationStats(sc, C) };
    const csv = drillsToCsv([{ operator: 'Sep Demo, A', unit: '=cmd', verified: true, record: rec }], C.training.certification.passMark);
    const [head, row] = csv.trim().split('\r\n');
    expect(head.split(',')).toContain('false_positives');
    expect(row.startsWith('"Sep Demo, A",\'=cmd,1,1970-01-01T00:00:00.000Z')).toBe(true);
    expect(row).toContain(',yes,yes,4,2,4,100,0,0,0');
  });
});
