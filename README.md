# PARASHURAMA

AI counter-drone decision trainer. SIH 2026 · PS SIH26247 (Ministry of Defence / Defence Services Staff College) · Team Dhwanik_TH06.

Trainees detect, identify and defeat drone and swarm threats on a laptop. A guided **Academy** teaches complete beginners with a coach that explains every clue and decision. Scored drills grade every decision against doctrine and explain it, an **expert ghost** replays the same drill perfectly, a learning model tracks each skill, and an **enemy AI** builds the next drill around each trainee's weaknesses. A **unit server** verifies every drill independently and gives commanders a readiness board.

**Live prototype:** `docs/index.html` is the whole app in one offline file; it is served by GitHub Pages (Settings → Pages → branch `main`, folder `/docs`).

## Who reads what

| You are | Read |
|---|---|
| Trainee | [docs/TRAINEE_GUIDE.md](docs/TRAINEE_GUIDE.md) and the printable [docs/FIELD_GUIDE.md](docs/FIELD_GUIDE.md) |
| Instructor | [docs/INSTRUCTOR_GUIDE.md](docs/INSTRUCTOR_GUIDE.md) |
| Admin / IT | [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) |
| Developer | this file |

Inside the app: a one-click narrated **90-second demo** (or open with `?demo`), a **Mission Hub** home screen, a **3D tactical view** (press **V** in a drill; VR-ready), **weather** and **real-world missions**, a guided **tour** on first visit (the **?** button replays it), the four-lesson **Academy**, the **Field guide** (**F**), and the coach.

## Quick start

Requires Node.js 22.5 or newer.

```bash
npm install
npm run dev                 # web app only (offline mode) at http://localhost:5173
npm run build && npm run server   # unit server with the web app at http://localhost:8080 (no login: opens straight in)
npm run ci                  # type-check, generated-code check, config check, all tests, all builds
npm run e2e                 # browser end-to-end tests
```

| Command | What it does |
|---|---|
| `npm run build:single` | One self-contained offline file: `apps/web/dist-single/index.html` |
| `npm run validate:config` | Check the doctrine/config files; run after every edit |
| `npm run gen:validators` | Re-generate the pre-compiled config validators after editing `config/schema/` |
| `npm run make-cert -- <name> <ip>` | Local CA + HTTPS certificate for the unit network |
| `docker compose up -d --build` | Unit server with HTTPS and daily backups (see the admin guide) |

## How it is built

```
parashurama/
├─ config/                 doctrine as data: threats, weapons, scoring rules, training settings (+ JSON Schemas)
├─ packages/engine/        pure TypeScript: deterministic simulation, scoring, expert ghost, learning model, enemy AI
│  └─ src/generated/       config validators pre-compiled at build time (no eval at runtime)
├─ apps/web/               Vite + TypeScript interface
│  └─ src/                 app (brief/fight/learn), academy + coach, field guide, audio, what-if, editor, online sync, PWA
├─ apps/server/            Fastify + built-in SQLite: name-only sign-in and roles, verification, config versions, readiness, backups
├─ deploy/                 HTTPS certificate script, systemd unit
├─ docs/                   trainee, field, instructor and admin guides
├─ Dockerfile, docker-compose.yml
└─ .github/workflows/ci.yml
```

**The determinism contract.** A drill is fully defined by its seed and the trainee's time-stamped decisions. Re-running them always gives the identical drill and score. That powers the expert ghost, the replay, *what if* rewinds, and server verification: the server re-runs every submitted drill, so a client cannot raise its own score.

## Configure

Instructors use the in-app **Instructor panel** (validated, versioned on the unit server). Developers can edit `config/*.json` directly and run `npm run validate:config`. Values are training values for simulation, not equipment specifications.

## Tests

| Suite | Proves |
|---|---|
| Engine: determinism | Same seed + decisions = identical drill; 40 mixed replays match live runs; scripted spawn distances |
| Engine: scoring | Golden test for every rule (D1, C1, R1–R8), incl. area-effect credit for swarms |
| Engine: fuzz | 200 random drills with random/invalid input: no crashes, scores in range, replays match |
| Engine: learning, enemy, config, integrity | Mastery model, first-drill plan, weakness targeting, config validation, SHA-256 chain |
| Server (14) | Name-only sign-in, rate limiting, roles, CSRF refusal, config versions, independent re-scoring, tamper detection, payload validation, readiness scoping, templates, users, backups, audit, logout |
| e2e (Playwright) | Tour, pause-during-tour, real radar click, verified debrief, adapted next drill, field-guide rules, a beginner completing Academy lesson 1 by following the coach |

Also verified manually during development: all four Academy lessons completed by a headless browser that obeyed the coach literally; a full online session against the production server bundle (login, server-verified drill, logout, instructor edit with validation, scripted drill, readiness board, offline reload via the service worker); HTTPS with the generated certificate chain.

## Status

- Phase 1 (monorepo, config, tests, CI): done.
- Phase 2 (server, logins, roles, sync, verification): done.
- Phase 3 (installable offline app, Docker, backups, HTTPS): done. Docker files were not executed in the build environment.
- Phase 4 (instructor editor, what-if rewind, sound and radio callouts): done. **VR mode is deferred**: it needs headset testing, which was not available.

## Known limitations

- The main UI module (`apps/web/src/app.ts`) is loosely typed; the engine and server are strictly typed and tested.
- The enemy AI is rule-based (explainable), not machine-learned.
- Offline (no server) mode uses labelled demo operators on the readiness board and keeps history in the browser.
- Voice callouts use the browser's built-in speech; voices vary by device.
