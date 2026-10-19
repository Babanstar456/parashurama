import { describe, expect, it } from 'vitest';
import { demoHistory, mastery, planNext, windOf, type SessionRecord } from '../src';

describe('enemy AI plans the next drill around weaknesses', () => {
  const H = demoHistory();
  it('targets the weakest condition', () => {
    const p = planNext(H);
    const m = mastery(H);
    const weakest = (['night', 'swarm', 'degraded', 'weather'] as const).reduce((a, b) => (m[a] <= m[b] ? a : b));
    if (weakest === 'swarm') expect(p.cfg.pattern).toBe('swarm');
    if (weakest === 'night') expect(p.cfg.time).toBe('night');
    if (weakest === 'degraded') expect(p.cfg.fault).not.toBe('none');
    if (weakest === 'weather') expect(p.cfg.weather).not.toBe('clear');
  });
  it('attacks from the sector the trainee watches least', () => {
    const p = planNext(H);
    expect(windOf(p.cfg.focus.sector!)).toBe('north-west');
    expect(p.lines[0].b).toMatch(/north-west/);
  });
  it('sends loitering munitions to someone who jams drones without radio links', () => {
    expect(planNext(H).cfg.focus.loiter).toBe(true);
    const clean: SessionRecord[] = H.map((s) => ({ ...s, jamNoRF: 0 }));
    expect(planNext(clean).cfg.focus.loiter).toBe(false);
  });
  it('keeps difficulty between 1 and 6 and is deterministic', () => {
    const hi = H.map((s) => ({ ...s, total: 99 })), lo = H.map((s) => ({ ...s, total: 5 }));
    for (const h of [hi, lo, H]) { const d = planNext(h).cfg.difficulty; expect(d).toBeGreaterThanOrEqual(1); expect(d).toBeLessThanOrEqual(6); }
    expect(planNext(H)).toEqual(planNext(H));
  });
  it('gives a brand-new trainee a gentle first drill with an honest briefing', () => {
    const p = planNext([]);
    expect(p.cfg.difficulty).toBe(2);
    expect(p.cfg.time).toBe('day');
    expect(p.lines[0].b).toBe('No drills yet.');
  });
});

describe('control mode for measuring training transfer (item 8)', () => {
  const H = demoHistory();
  it('ignores weaknesses: fixed level 3, no targeting, conditions from the seeded RNG', () => {
    const p = planNext(H, undefined, { adaptive: false });
    expect(p.cfg.difficulty).toBe(3);
    expect(p.cfg.focus).toEqual({ sector: null, loiter: false, decoy: false });
    expect(p.lines[0].b).toBe('Control group.');
    expect(planNext(H, undefined, { adaptive: false })).toEqual(p);
    const strong = H.map((s) => ({ ...s, total: 99 }));
    expect(planNext(strong, undefined, { adaptive: false }).cfg.difficulty).toBe(3);
  });
  it('adaptive mode is unchanged by the option', () => {
    expect(planNext(H, undefined, { adaptive: true })).toEqual(planNext(H));
    expect(planNext(H, undefined, {})).toEqual(planNext(H));
  });
  it('control drills still vary across histories', () => {
    const conds = new Set<string>();
    for (let i = 0; i < 20; i++) { const c = planNext(H.map((s, j) => ({ ...s, total: 30 + i + j })), undefined, { adaptive: false }).cfg; conds.add(`${c.time}/${c.pattern}/${c.fault}/${c.weather}`); }
    expect(conds.size).toBeGreaterThan(1);
  });
});
