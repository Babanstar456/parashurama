# Traceability: PS SIH26247 → code → tests → evidence

Every figure below is printed by the test suite as an `EVIDENCE …` line (`npm test`). Re-run it to reproduce them. These are simulated training measures, not operational effectiveness.

| PS requirement | Where it is built | Proved by |
|---|---|---|
| Desktop simulator, scripted and procedural scenarios | `packages/engine/src/engine.ts`, `scenario.ts`, `scenarios.ts`; `config/scenarios.json`; instructor drill builder `apps/web/src/editor.ts` | `determinism.test.ts`, `scenarios.test.ts`, `fuzz.test.ts`, e2e `drill.spec.ts` |
| VR optional | `apps/web/src/view3d.ts` (Three.js, WebXR entry) | e2e `hub.spec.ts` (3D view). WebXR has not been tried on a headset. |
| Day/night, degraded sensors, urban/rural, weather | `DrillConfig` (`time`, `fault`, `terrain`, `weather`); `config/training.json` | `weather.test.ts`, `scoring.test.ts` |
| Single drones and swarms; many drone types | `config/threats.json` (13 types across all three defeat classes), swarm motion and area effect in `engine.ts` | `library.test.ts` (the expert ghost defeats every hostile type), `scoring.test.ts` |
| Decision-tree scoring: detection time, classification, engagement | `scoring.ts` `scoreRun()`, `config.ts` `decisionClass()`, `config/doctrine.json` (rules D1, C1, R1–R8) | `scoring.test.ts` (golden case per rule), `evidence.test.ts` |
| False positives and missed threats | `packages/engine/src/report.ts` `classificationStats()` | `evidence.test.ts` |
| AAR: individual and unit performance across sessions | Debrief and readiness board (`apps/web/src/app.ts`); `/api/readiness`; CSV export `/api/export/drills.csv` and `drillsToCsv()` | `server.test.ts`, `apps/server/test/evidence.test.ts` |
| Adaptive difficulty and randomisation | `enemy.ts` `planNext()`; learning model `learning.ts` (Bayesian knowledge tracing) | `enemy.test.ts`, `learning.test.ts`, `evidence.test.ts` |
| Ordinary computers, unit level | Single offline file `docs/index.html`; unit server on SQLite | `evidence.test.ts` (headless speed); `?fps` meter |
| Tamper-evident records | Server re-runs each drill (`apps/server/src/verify.ts`); SHA-256 chained log (`integrity.ts`) | `integrity.test.ts`, `server.test.ts` |

## Measured evidence (19 Oct 2026, 13-type library)

| Measure | Result |
|---|---|
| Unique drills from 100 seeds | 100 |
| Distinct threat mixes in those 100 drills | 93 |
| Bearing sectors used | 12 of 12 |
| Distinct next drills from 20 different trainee histories | 20 |
| Measured detection time for a 2 s reaction | 2.0 s |
| Disciplined trainee (4-contact drill) | 100% identification, 0 false positives, 0 missed hostiles, score 98 |
| Trigger-happy trainee (same drill) | 25% identification, 2 false positives, score 57 |
| Inattentive trainee | 2 of 2 hostiles missed, scores 0/0 |
| Careful vs careless trainee, 3 sessions | scores 98/98/98 vs 57/57/57; identification mastery 87% vs 10% |
| Weakest condition targeted by the planner | 4 of 4 |
| One bad drill after three good ones | difficulty 4 → 3 |
| Sustained averages 90 / 70 / 40 | levels 4 / 3 / 2 |
| Headless engine speed | several thousand × real time (varies by machine; 5,250–5,900× on the dev laptop) |
| Sessions surviving a server restart | 3 of 3 |
| Single-file app size | 1.17 MB (490 KB gzipped) |

Before the 13-type library, the same suite measured 14 distinct threat mixes (the original 3-type hostile pool).

## Still to measure

| Measure | How |
|---|---|
| Frame rate on the presentation laptop | Open the app with `?fps`: hub, a 2D drill, and the 3D view (press **V**). Record the current and lowest values here. |
| Multi-trainee load on the unit server | Not yet tested. |
