# Changelog

## Unreleased
- **Lite mode for low-spec laptops**:
  - On the first scored drill, the app measures the average frame rate over 5 s. Below 25 fps it switches to Lite mode: the 3D view is not auto-opened, the 3D pixel ratio is 1×, and there are no 3D weather particles.
  - The trainee is told, and can toggle it with the drill's **Lite** button or **L**. `?lite` forces it.
  - The setting is saved with the trainee's settings.
- **Encryption at rest**:
  - Drill records and decision logs are sealed with AES-256-GCM (`apps/server/src/crypto.ts`, format `v1:<iv>:<tag>:<ct>`).
  - The key comes from `PARASHURAMA_DATA_KEY` or `PARASHURAMA_DATA_KEY_FILE`, which must be outside the data directory.
  - With `NODE_ENV=production` the server refuses to start without a key. Docker Compose (as a secret) and the systemd unit now supply one.
  - `npm run migrate:encrypt -w @parashurama/server` encrypts existing rows, and old plaintext rows stay readable.
  - The admin guide documents BitLocker/LUKS as a second layer.
- **Signed threat packs** (`*.cuaspack.json`):
  - Packs are signed with ECDSA P-256 / SHA-256 over canonical JSON. The verifier in `packages/engine/src/pack.ts` uses WebCrypto, so it runs in both the browser and Node.
  - Trusted public keys live in `config/trust/keys.json`, which ships empty. `npm run pack:keygen` refuses to write the private key inside the repo, and `npm run pack:sign` signs a pack.
  - `POST /api/packs` (instructor or admin) checks the signature, then validates the merged config, then stores it as a config version. Every attempt is audited.
  - The offline Instructor panel has "Import signed threat pack", which runs the same checks.
- **Supply chain**:
  - `npm run sbom` writes a CycloneDX SBOM to `docs/sbom.cdx.json`. `npm run notices` turns it into `THIRD_PARTY_NOTICES.md` (66 production packages).
  - `npm run audit:prod` runs in CI.
  - Upgraded `@fastify/static` 8 → 10.1.6 to fix high-severity advisories (path traversal and route-guard bypass, GHSA-pr96-94w5-mx2h and others). Static serving was re-tested.
  - `npm run release:docs` publishes `docs/index.html` and writes its SHA-256 to `docs/RELEASE.txt`.
  - A LICENSE is still to be agreed by the team.
- **Control group for measuring training transfer**:
  - `planNext(H, C, { adaptive: false })` gives fixed level 3, conditions drawn at random from the seed, and no targeting. Adaptive mode is unchanged.
  - Users have a study `cohort` (`adaptive` or `control`), added by database migration 2. Existing users become `adaptive`.
  - An instructor or admin sets the cohort in the Users panel or with `PUT /api/users/:id/cohort`.
  - The web app plans control-group drills accordingly.
  - The CSV export has a `cohort` column.
- **Sensor-down fairness flag**:
  - Each identification records which clues were available: RF detector up, a clear camera picture in range, and healthy radar on that bearing.
  - The debrief explains when a fault removed a clue, and the drill tape rings that identification in amber.
  - Points never change, because doctrine expects inference from the remaining clues.
- **EW collateral (R11)** (effectors 1.2.0, doctrine 1.4.0, scenarios 1.2.0):
  - New optional `ewRestricted` drill flag, and `ewCollateral` on the jammer and spoofer.
  - Jamming or spoofing in an EW-restricted area without clearance costs −10 (R11).
  - "Airport in heavy rain" is EW-restricted.
  - The brief and mission cards show it.
  - The threat-library calculator has R11 and R12 options.
- **Rules of engagement and clearance (R12)** (doctrine 1.3.0, scenarios 1.1.0):
  - Drills take an optional `roe`: `free` (default, unchanged), `tight` (gun and interceptor need clearance) or `peacetime` (every effector needs clearance, 6 s).
  - New `req` action: Request clearance, key **C**, with a countdown. Effectors that still need clearance show a lock.
  - Firing without clearance still takes effect, but costs −40 (R12).
  - New `roe` skill on the skill fingerprint and readiness board.
  - The expert ghost and the demo operator ask for clearance as soon as they identify a hostile.
  - "Airport in heavy rain" now runs under peacetime ROE.
  - The server accepts `req` actions and `cfg.roe`.
  - Drills without `roe` record no clearance data, so they are unchanged.
- **Probability of kill and re-engagement (R10)** (effectors 1.1.0, doctrine 1.2.0):
  - Effectors have an optional `pk` (hit chance). It is set to 1 for every effector, so behaviour is unchanged until instructors set training values in the Instructor panel's new "Hit chance" column.
  - Misses are seeded, so replays and the server re-run match.
  - The first choice is still what gets scored.
  - R10: a miss that is not followed by another engagement costs −10. If the drone then leaks, R10 is named alongside R8.
  - On a miss the trainee sees a MISS toast and note, and the drill tape shows a ✕ marker.
  - After a miss, the expert ghost re-engages with the effector of highest expected value (points × pk).
- **Civil drones (R9)** (threats 1.2.0, doctrine 1.1.0, training 1.3.0):
  - New `civil` threat flag and a registered civil drone type.
  - Rule R9: report and monitor, never engage. Held scores 40; engaged scores 0.
  - Urban procedural drills include one civil drone, but only when `scenario.civilType` is set, so older configs build identical drills.
  - The Hold button is now "Hold / report".
- **Military threat library** (threats 1.1.0, training 1.2.0): seven new types, so all three defeat classes are covered:
  - Fibre-optic FPV and AI-guided attack drone (no radio and no GNSS, so only an interceptor or gun works).
  - Jet one-way attack drone (GNSS-guided, very fast).
  - Payload-drop drone.
  - Hybrid VTOL ISR drone.
  - Tactical ISR fixed-wing.
  - Large military UAV (MALE), with a new `Large` echo size.
  - New `surveil` motion: the drone flies in, then circles at standoff range.
  - Every new hostile type is in the procedural pool.
  - Identify keys now run 1–9 then 0.
  - The field guide and the threat library page list all 13 types.
  - `library.test.ts` checks that the expert ghost defeats every hostile type.
- **Evidence update (19 Oct 2026)**:
  - `classificationStats()` (false positives, missed hostiles) and `drillsToCsv()` in `packages/engine/src/report.ts`.
  - Role-scoped, audited `GET /api/export/drills.csv`.
  - "Download drill history (CSV)" button on the Unit readiness card.
  - `?fps` frame-rate meter.
  - Evidence tests: `packages/engine/test/evidence.test.ts` and `apps/server/test/evidence.test.ts`.
  - `docs/TRACEABILITY.md`.
- `CLAUDE.md` project context for contributors.
- **No login screen**: the web app signs in to the built-in `admin` account automatically, and the logout button is hidden. The unit server's sign-in API takes a name only, with no password. A new name creates a trainee account and the same name returns to it. Admins can still pre-create instructor, commander and admin accounts (no password field). `ADMIN_PASSWORD` and the first-start password printout are gone; sign in as `admin`. The `user:add` CLI no longer takes a password.

## 0.6.0 – One-click narrated demo, phone-ready
- **Watch the 90-second demo** (Mission Hub, or open the app with `?demo`): a self-running, narrated showcase. A scripted operator plays the *Airport in heavy rain* mission and makes realistic mistakes; captions freeze the action at each key moment (mission, detect, identify, defeat, the 3D chase view), then walk through the debrief, the expert ghost and the commander's readiness board, ending on "Try it yourself" / "Watch again". Demo runs are practice runs: never saved to history and never synced to the unit server. Esc exits at any point.
- **Phones**: every screen fits a 390 px phone with no sideways scrolling (the briefing layout and skill fingerprint were wider than the screen and forced a zoom-out, which also covered the Begin button); the hub opens at the title; drill controls no longer overlap the clock; a tip explains that full drills are best on a laptop.
- Tests: 61 unit/server + 12 browser tests (3 new: full demo end to end without saving, Esc exit, phone layout in every phase).

## 0.5.0 – Mission Hub and 3D tactical view
- **Mission Hub** home screen: explains the product in one screen and gives one-click paths for beginners (Academy, with progress), trainees (adaptive quick drill, naming their weakest skill), field units (the four real-world missions) and commanders (readiness board). Header **Home** button (hidden during drills). The first-visit tour now waits until the user picks a path. `?nohome` skips the hub (deep links, tests).
- **3D tactical view** (PS outcome 1, desktop/VR simulator), built with Three.js: the live drill as a 3D battlespace with seeded terrain (city blocks or trees), the protected base with a rotating radar, reach rings, the radar sweep, drones with spinning rotors, height lines, trails and labels, weather (rain, fog, dust particles and visibility), night lighting, and weapon effects (jammer/spoof beams, interceptor and gun rounds, neutralisation bursts).
  - Fair by design: only contacts the radar has detected are drawn, and an unidentified drone stays a yellow marker until it is inside camera range.
  - Picture-in-picture by default; **V** or *Expand* fills the radar area; drag to orbit, scroll to zoom, click a drone to track/select it; **Follow** chase camera flies behind the selected (or most urgent) threat; minimise button (remembered; minimised in the Academy).
  - **WebXR VR** entry appears when the browser reports a VR headset (stands the trainee on the radar tower). Not yet tested on a physical headset.
  - Falls back silently to the 2D radar when WebGL is unavailable.
- Tests: 61 unit/server + 9 browser tests (3 new: hub paths, keyboard safety on the hub, 3D view expand/minimise).

## 0.4.0 – Weather and real-world scenarios
- **Weather** (PS outcome 5, realistic conditions): clear, heavy rain, dense fog and dust storm. Each degrades radar detection, camera identification range and image quality, set as training values in `config/training.json` (`weather`, schema-validated). Shown on the brief, sand table, radar scope, camera view, clue panel and debrief.
- **Learning model**: new skill *Bad weather*; the enemy AI now sends bad weather to trainees who are weak in it. Readiness board gains a *Bad weather* column and console filter.
- **Real-world scenario library** (`config/scenarios.json`): four scripted, scored drills for Army/IAF air defence, BSF and CISF (air base at night, border post in fog, airport in rain, forward-post swarm in a dust storm), each with context and a lesson shown at start and in the debrief.
- Instructor scripted-drill builder and server verification support weather. Field guide has a bad-weather rule.
- Backward compatible: drills recorded without weather replay exactly as clear weather.
- Tests: 61 unit/server (9 new: weather effects, enemy weather targeting, scenario validity, expert ghost wins every scenario) + 6 browser tests.

## 0.3.0 – Phases 2–4 and training
- **Academy**: four guided lessons with a coach that explains every clue, recommends the identification and weapon with reasons, highlights the exact button, pauses for beginners and fades help in lesson 4.
- **Field guide** (F), printable field guide, trainee/instructor/admin guides.
- **Unit server**: Fastify + SQLite, scrypt passwords, sessions, roles, rate limiting, CSRF refusal, strict CSP, audit log, versioned doctrine config, server-side drill re-scoring with tamper and plausibility flags, readiness board, scripted drills, backups, user CLI.
- **Online client**: login, sync with an offline outbox, real readiness board, per-user settings.
- **Instructor panel**: validated edits of weapons, doctrine points, certification and threats; scripted drill builder; user management.
- **What if** rewind in the debrief; sound cues and spoken radio callouts.
- **Installable offline app** (service worker, manifest, icons); Dockerfile, Compose with daily backups, systemd unit, local HTTPS certificate script.
- Engine: scripted spawn distances; gentle first drill for new trainees; swarm drones neutralised by area effect inherit the engaged drone's identification.
- Fixes: radar crash on area-effect kills (and a crash-proof frame loop); config validators pre-compiled (no eval, CSP-safe); empty JSON bodies accepted.

## 0.2.0 – Phase 1
- Monorepo, config-driven doctrine, engine test suite, Playwright e2e, CI, single-file offline build.

## 0.1.0 – Prototype v2
- Brief → fight → learn flow, tour, clue build-up with confidence, decision windows, expert ghost, analytics, enemy AI, readiness board.
