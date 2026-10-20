# Traceability: PS SIH26247 → code → tests → evidence

Every figure below is printed by the test suite as an `EVIDENCE …` line (`npm test`). Re-run it to reproduce them. These are simulated training measures, not operational effectiveness.

| PS requirement | Where it is built | Proved by |
|---|---|---|
| Desktop simulator, scripted and procedural scenarios | `packages/engine/src/engine.ts`, `scenario.ts`, `scenarios.ts`; `config/scenarios.json`; instructor drill builder `apps/web/src/editor.ts` | `determinism.test.ts`, `scenarios.test.ts`, `fuzz.test.ts`, e2e `drill.spec.ts` |
| VR optional | `apps/web/src/view3d.ts` (Three.js, WebXR entry) | e2e `hub.spec.ts` (3D view). WebXR has not been tried on a headset. |
| Day/night, degraded sensors, urban/rural, weather | `DrillConfig` (`time`, `fault`, `terrain`, `weather`); `config/training.json` | `weather.test.ts`, `scoring.test.ts` |
| Acoustic sensing | Optional `acoustic` signature per threat (`config/threats.json`) and sensor block (`config/training.json`: terrain, night and weather factors); `acousticClue()` in `engine.ts`; *Acoustic* clue in the drill and a column in the field guide | `acoustic.test.ts` (ranges by condition; a fibre-optic FPV with no radio is heard close in; drills and scores identical with and without the sensor; old configs still valid) |
| Single drones and swarms; many drone types | `config/threats.json` (14 types: all three defeat classes, plus friendly, civil and clutter), swarm motion and area effect in `engine.ts` | `library.test.ts` (the expert ghost defeats every hostile type), `scoring.test.ts` |
| Decision-tree scoring: detection time, classification, engagement | `scoring.ts` `scoreRun()`, `config.ts` `decisionClass()`, `config/doctrine.json` (rules D1, C1, R1–R12) | `scoring.test.ts` (golden case per rule), `evidence.test.ts` |
| Civil airspace: report, don't engage | `civil` threat flag, rule R9 in `scoreRun()`, urban civil contact in `buildScenario()` | `scoring.test.ts` (R9 golden cases; old configs unchanged) |
| Imperfect effectors ("nothing works 100%") | Effector `pk`, seeded hit roll in `applyAction()`, rule R10 in `scoreRun()`, expert re-engagement in `expert.ts` | `scoring.test.ts` (miss recorded, R10, deterministic misses, expert re-engages) |
| Chain of command (ROE, clearance) | `DrillConfig.roe`, `doctrine.json` `roe` profiles, `req` action and `isCleared()` in `engine.ts`, rule R12, `roe` skill in `learning.ts` | `scoring.test.ts` (R12, clearance flow, expert wins under peacetime), `server.test.ts` (server accepts and re-scores `req` actions) |
| EW collateral near airports and own forces | `DrillConfig.ewRestricted`, effector `ewCollateral`, rule R11 in `scoreRun()` | `scoring.test.ts` (R11 applies; not to interceptors or cleared shots; unchanged without the flag) |
| Fair scoring with degraded sensors | `clueAvailability()` in `engine.ts` records `idAvail` at identification; notes in `scoreRun()`; amber ring on the drill tape | `scoring.test.ts` (RF off and radar-sector cases; points unchanged) |
| False positives and missed threats | `packages/engine/src/report.ts` `classificationStats()` | `evidence.test.ts` |
| Air defence gun detachment (ZU-23-2 manual sight, ZSU-23-4 radar fire control) | `packages/engine/src/ballistics.ts` (point-mass RK4, Mach-dependent drag, standard atmosphere from site met, wind, Coriolis, muzzle-velocity temperature effect, seeded dispersion, lead solver), `gun.ts`, `gunai.ts`, `gunscore.ts` (G1–G12), `config/guns.json` (training values); web `apps/web/src/gun.ts` | `ballistics.test.ts` (vacuum closed form, drop and time of flight, lead, wind, temperature, dispersion), `gun.test.ts` (determinism, expert passes, G1/G5/G10/G12 cases), e2e `gun.spec.ts` |
| Two separate games: Control Room and On Ground | Control Room (F1–F8: alert, indicate, sequence, Weapon Control Status, safe arcs, priority, range, cease/hold, close) and On Ground (G1–G12) on one shared engine; fire without clearance deducts points | `gun.test.ts` (F2, F3, F4, G1, G10), e2e `gun.spec.ts` |
| Live-fire drill procedure | `guns.json` `lfx` checklists (a draft for DSSC); L1 gun checks before loading, L2 range checks before RANGE CLEAR, L3 every unexploded round located before RANGE GREEN; procedure tracker with ticks in both games | `gun.test.ts` (L1–L3) |
| Gun reload training | Step-by-step reload per gun, in order and timed (G12); shuffled step buttons; Reload drill practice | `gun.test.ts` (out-of-order step counted; expert vs fumbling trainee) |
| Several trainees as one crew over the LAN | `apps/server/src/gun.ts` crew rooms: server runs the drill at 10 Hz, inputs stamped with the sender's seat, Server-Sent Events to every client, AI in empty seats; per-seat records stored and sealed | `apps/server/test/gun.test.ts` (two trainees, mirrored replay equals server scores; forged AI orders ignored; late join rebuilds), `npm run crewload` |
| UAV ground-control-station strike drill (extension beyond the PS) | `packages/engine/src/gcs.ts` (corridor and geofence, clearances, Master Arm interlock, impact point, free-fall release on the same ballistics), U1–U9; web `apps/web/src/gcs.ts` | `gcs.test.ts` (expert all hits, determinism, U1/U3/U4/U6), e2e |
| Control measures in the radar drill | `DrillConfig.wcs` (R13), `safeArcs` (R14), `killAssess` (R15), explicit Unknown identification, rank by time to the asset, own-UAV schedule in the brief; all optional | `measures.test.ts`, `apps/server/test/measures.test.ts`; golden `scoring.test.ts` unchanged |
| Self-study: classroom videos and notes by course | Classroom library (`apps/web/src/lectures.ts`; server routes in `apps/server/src/lectures.ts`): videos, PDF, images, text précis; courses incl. Control Room, On Ground, UAV GCS, Live-fire safety | `apps/server/test/lectures.test.ts` (upload, range streaming, roles, limits, delete, notes, HTML/SVG refused), e2e `lectures.spec.ts` (offline video and text note) |
| AAR: individual and unit performance across sessions | Debrief and readiness board (`apps/web/src/app.ts`); `/api/readiness`; CSV export `/api/export/drills.csv` and `drillsToCsv()` | `server.test.ts`, `apps/server/test/evidence.test.ts` |
| Adaptive difficulty and randomisation | `enemy.ts` `planNext()`; learning model `learning.ts` (Bayesian knowledge tracing) | `enemy.test.ts`, `learning.test.ts`, `evidence.test.ts` |
| Proof that training transfers (study design) | `planNext(..., { adaptive: false })` control mode; `users.cohort`; `cohort` column in the CSV export | `enemy.test.ts` (control ignores weaknesses, adaptive unchanged), `apps/server/test/evidence.test.ts` (cohort set and exported) |
| Ordinary computers, unit level | Single offline file `docs/index.html`; unit server on SQLite; automatic Lite mode (`apps/web/src/lite.ts`) | `evidence.test.ts` (headless speed); `?fps` meter with a per-view report and `npm run fps` (`scripts/fps.mjs`); e2e `hub.spec.ts` (Lite keeps the 3D view closed) |
| Many trainees on one unit server | `scripts/loadtest.ts` (`npm run loadtest`, or `--url` for a real LAN server) | `apps/server/test/load.test.ts` (10 trainees × 3 drills at once: all accepted, re-verified and stored) |
| Untampered offline updates | Signed threat packs: `pack.ts` (`verifyPack`, `canonical`), `config/trust/keys.json`, `POST /api/packs`, editor import | `pack.test.ts` (valid accepted; changed byte, unknown or untrusted key rejected; invalid config caught), `apps/server/test/evidence.test.ts` |
| Personnel data protection | AES-256-GCM sealing of drill records and logs (`apps/server/src/crypto.ts`), key outside the data directory, refuse-to-start in production, `migrate-encrypt` | `apps/server/test/encryption.test.ts` (ciphertext at rest, restart and CSV export with a key, migration, wrong key) |
| Supply-chain hygiene | `docs/sbom.cdx.json`, `THIRD_PARTY_NOTICES.md`, `npm run audit:prod` in CI, `docs/RELEASE.txt` (SHA-256 of the offline file) | CI workflow `.github/workflows/ci.yml` |
| Tamper-evident records | Server re-runs each drill (`apps/server/src/verify.ts`); SHA-256 chained log (`integrity.ts`) | `integrity.test.ts`, `server.test.ts` |

## Measured evidence (20 Oct 2026, 14-type library, radar rules up to R15, gun and UAV drills)

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
| Headless engine speed | thousands × real time (varies with machine load: 2,500–5,900× on the dev laptop) |
| Sessions surviving a server restart | 3 of 3 |
| Single-file app size | 1.47 MB (557 KB gzipped) |
| Acoustic hearing range, fibre-optic FPV (training values) | rural day 350 m, urban day 210 m, rural night 437.5 m, urban in rain 126 m |
| Unit server, 30 trainees × 5 drills submitted at the same moment | 150 of 150 accepted and re-verified, 0 lost; submit latency p50 158.6 ms, p95 271.9 ms; 0.98 s in all |
| Unit server, 60 trainees × 5 drills at the same moment | 300 of 300 accepted and re-verified, 0 lost; submit latency p50 280.3 ms, p95 460.4 ms; 1.69 s in all |
| Frame rate on the dev laptop (i3-1005G1, Chromium, `npm run fps -- --sec 8`) | menus 58 fps (lowest 49); drill with radar and small 3D 58 (lowest 48); 3D expanded 60 (lowest 59) |
| Frame rate of the new screens on the dev laptop (visible Chromium, 8 s each) | On Ground gun sight 60 fps (worst frame 33 ms); Control Room air picture 60 fps (33 ms); UAV GCS map + camera 60 fps (17 ms) |
| Gun ballistics, 23 mm HEI-T training model | time of flight / superelevation: 1,000 m 1.23 s 6.3 mil; 1,500 m 2.06 s 11.3 mil; 2,000 m 3.10 s 18.0 mil. Lead on a 30 m/s crossing target at about 1,500 m: 2.41° (speed × time of flight 2.36°) |
| Gun expert crews, 10 drills each | ZU-23-2 manual sight 15/20 destroyed, 79 rounds per kill, average 88; ZSU-23-4 radar 20/20, 86 rounds per kill, average 96 |
| Reload drill (3 reloads, ZU-23-2) | expert 100; trainee with steps out of order 92 |
| Crew drill over the LAN (test) | 2 trainees, 823 ticks streamed; control 90, gun 85; both stored and equal to each client's own replay |
| Crew drills at once, real 10 Hz clock (dev laptop, `npm run crewload`) | 10 crews (20 clients): 149 of ~150 ticks each, spacing p50 100 ms, p99 126 ms, server CPU 10% of a core; 30 crews (60 clients): 149 of ~150, p99 135 ms, CPU 22% |
| UAV strike drill, expert over 10 missions | all landed, all hits, miss 1.1–2.0 m (lethal radius 8 m) |

The load figures come from `npm run loadtest` on the dev laptop (i3-1005G1, 4 threads). Client and server shared that machine over loopback, each trainee on its own loopback address, with no think time, so this is a worst-case burst without real network delay. The sign-in limit (30 per address per minute) stops a class that shares one address; see the admin guide.

Before the 13-type library, the same suite measured 14 distinct threat mixes (the original 3-type hostile pool).

## Still to measure

| Measure | How |
|---|---|
| Frame rate on the presentation laptop | `npm run build:single && npm run fps` on that laptop, or open `docs/index.html?fps`, use the menus, a drill and the 3D view (**V**), then click the meter to copy the report. Record it here. |
| Load over a real LAN | `npm run loadtest -- --url http://<server>:8080` from a second PC against a test server. |
| VR headset | WebXR entry is built; not yet tried on a headset. |
| Gun, ammunition, reload and UAV values; words of command | All are training values or placeholders (`config/guns.json`). DSSC / AAD College to confirm or replace. |
| Gun drills on the presentation laptop and a real LAN | `npm run fps` covers the radar views; open the gun drills and note the frame rate; run `npm run crewload` and a two-PC crew drill on the unit network. |
