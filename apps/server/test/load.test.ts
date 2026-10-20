// Evidence: a class of trainees submitting drills at the same time; every drill is re-verified and none is lost.
// A reduced run of scripts/loadtest.ts (npm run loadtest for the full class).
import { describe, expect, it } from 'vitest';
import { evidenceLines, runLoadTest } from '../../../scripts/loadtest';

describe('evidence: multi-trainee load', () => {
  it('accepts 10 trainees x 3 concurrent drills with no lost writes', async () => {
    const r = await runLoadTest({ trainees: 10, drills: 3, boardMs: 200 });
    for (const l of evidenceLines(r)) console.log(l);
    expect(r.errorSamples).toEqual([]);
    expect(r).toMatchObject({ submitted: 30, accepted: 30, rejected: 0, errors: 0, expected: 30, stored: 30, perTraineeOk: true, chainsMatch: 30, scoresMatch: 30 });
  }, 30_000);
});
