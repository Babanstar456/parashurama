# Changelog

## Unreleased
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
