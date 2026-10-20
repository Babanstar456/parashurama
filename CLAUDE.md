# PARASHURAMA (SIH26247): project context

AI counter-drone decision trainer. Trains the **recognize → classify → respond** skill, not one specific radar. Smart India Hackathon 2026, PS **SIH26247** (MoD / DSSC), Team Dhwanik_TH06, Team ID 153230. Previously named ARJUNA.

**When the repo contradicts a deck or brief, the repo wins.**

## PS deliverables
1. A desktop simulator (VR optional) with scripted and procedural scenarios.
2. Decision-tree scoring of detection time, classification accuracy and the engagement decision.
3. An AAR dashboard showing individual and unit performance across sessions.
4. Adaptive difficulty and randomisation, so drills cannot be learned by rote.

Conditions to cover: day/night, degraded sensors, urban/rural, single drones and swarms. Constraint: runs at unit level on ordinary computers.

`docs/TRACEABILITY.md` maps each deliverable to code, tests and measured evidence.

## Stack (never claim anything else)
- **TypeScript monorepo, v0.6.0.**
  - `packages/engine`: pure, deterministic simulation, scoring, learning and enemy AI.
  - `apps/web`: Vite app. Canvas 2D radar, Three.js 3D view, WebXR entry.
  - `apps/server`: Fastify and `node:sqlite` (WAL), cookie sessions, roles, audit log, backups, HTTPS.
  - `config/*.json`: the doctrine as data, with JSON Schemas in `config/schema/`.
- **Not used:** Python, React, FastAPI, PostgreSQL, "CART-tuned" scoring.
- **Sign-in:** there is no login screen. The web app signs in to the built-in `admin` account automatically. The server's login API takes a name only, with no password.

## Commands
- `npm run ci`: typecheck, check:generated, validate:config, tests, build, build:single.
- `npm run e2e`: Playwright. Set `PW_CHROMIUM_PATH` if a local Chromium is needed.
- `npm run dev` runs the web app only (offline). `npm run build && npm run server` runs it with the unit server on :8080.
- **Updating `docs/index.html`** (served by Vercel, root `docs/`): run `npm run release:docs`. It builds the single file, drops the manifest and icon links, and writes the SHA-256 to `docs/RELEASE.txt`.
- **Supply chain:** run `npm run audit:prod` (CI fails on high or critical) and `npm run sbom && npm run notices`. Licence: Apache-2.0 (`LICENSE`, `NOTICE`).
- **Capacity checks:** `npm run loadtest` (unit server, many trainees; `--url` for a real server) and `npm run fps` (frame rate per view, visible browser; needs `npm run build:single`).
- `apps/web/index.html` is the Vite **source** entry page (it loads `/src/main.ts`). Never overwrite it with a built bundle.
- **App URL flags:** `?demo`, `?reset`, `?nohome`, `?instructor` (offline editor), `?fps` (frame-rate meter), `?lite` (force Lite mode).

## Engine rules to preserve
- **Determinism.** A drill is fully defined by its seed and its time-stamped decision log. Never use `Math.random()` in the engine; use `mulberry` and `hash2` from `util.ts`. The server re-runs every drill, and the log is SHA-256 chained.
- **Compatibility.** New config fields are optional, with defaults that reproduce today's behaviour (follow the `weather?` pattern). Golden tests in `scoring.test.ts` are never edited; add new ones instead.
- **Config changes.** Edit the schema first, run `npm run gen:validators`, update `config.ts` types, add cross-file checks to `validate.ts`, and bump the file's `version`.
- **Scoring changes.** Each one needs a rule id in `doctrine.json` `rules`, and each point change pushes that rule id and a plain sentence into `why` in `scoreRun()`. The expert ghost (`expert.ts`) must stay doctrine-optimal; `scenarios.test.ts` checks it wins every mission.
- **Decision classes** (`decisionClass()`):
  - radio link → `rfLinked` (jam)
  - no radio, GNSS → `gnssOnly` (spoof)
  - neither → `autonomous` (interceptor)
- **Points.** Each contact is scored out of Detect 30 + Identify 30 + Defeat 40. Pass mark 75; certified mastery ≥ 80%, developing 55–80%.
- **The doctrine tree is rule-based, not machine-learned.** This is deliberate: it is explainable and needs no dataset.
- **Wording.** The code calls IFF the "Friendly check".
- **Rules added after v0.6.0** (all optional, so old drills replay unchanged):
  - R9: civil drone, report but never engage.
  - R10: re-engage after a miss. Effector `pk` defaults to 1.
  - R11: EW collateral in `ewRestricted` areas.
  - R12: fire only with clearance under `roe` `tight` or `peacetime`. The new `req` action requests clearance, and there is a new `roe` skill.
  - Sensor-down fairness note (`idAvail`): explains a missing clue but never changes points.
  - Acoustic sensing: optional `acoustic` per threat and in `training.json`; `acousticClue()` is a clue only and never changes a drill or a score.
- **Planner options and security features:**
  - Control-group planning: `planNext(H, C, { adaptive: false })`, with a `cohort` per user.
  - Signed threat packs: `pack.ts`, `config/trust/keys.json`, `POST /api/packs`.
  - Encryption at rest of drill records: `apps/server/src/crypto.ts`. The key comes from `PARASHURAMA_DATA_KEY` or `PARASHURAMA_DATA_KEY_FILE`, and is required when `NODE_ENV=production`.
  - Lite mode: `apps/web/src/lite.ts`.
  - Lecture library: `apps/web/src/lectures.ts` (server API online, IndexedDB offline) and `apps/server/src/lectures.ts` (`/api/lectures`, files in `DATA_DIR/lectures/`, range streaming).
- **Threat library** (`config/threats.json`). Training values only, not equipment specifications.
  - The original six: recon, fpv, loiter, swarm, friendly, bird.
  - Military types added since: fibre-optic FPV, AI-guided attack, jet one-way attack, payload dropper, hybrid VTOL ISR, tactical ISR fixed-wing, large MALE UAV.
  - `surveil` motion: the drone flies in, then circles at standoff range.
  - Identify keys are 1–9 then 0 (the first 10 types); the rest are click-only.

## Honesty rules (anything judges see)
- Use only measured numbers. Get them from the `EVIDENCE …` lines printed by `npm test`, never from memory. Never invent prices.
- Mark vendor features as "not stated publicly", not "missing".
- Simulated scores are training measures, not operational effectiveness.
- Use DPDP-safe demo operators only, with no real names.
- The research spreadsheet is internal: never link it from this repo.

## Working preferences
- Make minimum, declared edits. Preserve existing logic and config values unless the change is declared.
- Work in short, iterative steps with plain-language summaries.
- Deliverables for the jury are files (PDF/DOCX/HTML).

## Open items
- Record `npm run fps` (or `?fps` report) results from the presentation laptop in `docs/TRACEABILITY.md`.
- VR: the WebXR entry has never been tried on a headset. Say "WebXR-ready, headset trial next".
- DSSC review of the doctrine values, the threat values and the acoustic values.
- Load test over a real LAN (`npm run loadtest -- --url …`). The single-machine burst test is done (see TRACEABILITY).
