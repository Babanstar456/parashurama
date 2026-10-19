# Admin guide: install, deploy, operate

Three ways to run PARASHURAMA, from simplest to fullest.

## 1. Single laptop, fully offline (no server)

```bash
npm ci && npm run build:single
```
Copy `apps/web/dist-single/index.html` to the laptop and open it in Chrome or Edge. Fonts are embedded and nothing uses the network. Drill history stays in that browser.

## 2. Unit server with Docker (recommended)

Requires Docker with Compose on a small PC on the unit network.

```bash
bash deploy/make-cert.sh parashurama.local 192.168.1.10   # name and IP of the server
docker compose up -d --build
```
Trainees open `https://parashurama.local` (or `https://192.168.1.10`). Install `deploy/certs/unit-ca.crt` as a trusted root certificate on each laptop once, so browsers trust the server. The app can also be installed from the browser (*Install app*) and keeps working if the network drops; drills made offline sync when the server is reachable again.

The `backup` service writes a consistent copy of the database every day to the data volume (`/data/backups`, newest 14 kept).

> The Dockerfile and Compose file are provided but were not executed in the build environment (no Docker available there). The server itself, HTTPS, backups and the CLI were tested directly with Node.

## 3. Unit server without Docker (systemd)

Requires Node.js 22.5 or newer.

```bash
sudo useradd -r parashurama && sudo mkdir -p /var/lib/parashurama && sudo chown parashurama /var/lib/parashurama
sudo git clone <repo> /opt/parashurama && cd /opt/parashurama && sudo npm ci && sudo npm run build
sudo bash deploy/make-cert.sh parashurama.local 192.168.1.10
sudo cp deploy/parashurama.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now parashurama
```

There is no login screen. The web app signs in to the built-in `admin` account automatically, so everyone who opens it has full access (instructor panel and admin tools included). The server's sign-in API still accepts a name only, with no password.

## Server settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8080 (8443 with TLS) | Listening port |
| `DATA_DIR` | `./data` | Database and backups |
| `WEB_DIR` | `../web/dist` | Built web app to serve |
| `TLS_CERT`, `TLS_KEY` | – | Enable HTTPS (cookies become Secure, HSTS on) |
| `ADMIN_USERNAME` | `admin` | First admin account (created only if no users exist) |
| `UNIT_NAME` | `Unit` | Unit name for the first admin |
| `LOG` | on | `0` to silence request logs |

## Accounts and roles

| Role | Can |
|---|---|
| Trainee | Train, see own results |
| Instructor | Edit doctrine and settings, publish scripted drills, see the unit board |
| Commander | See the unit board |
| Admin | Everything, plus users, backups and the audit log |

Trainee accounts are created automatically the first time someone signs in. To give someone the instructor, commander or admin role, create their account before they first sign in, either in the instructor panel (*Users*, admin only) or on the command line. They then sign in with that name or username:
```bash
DATA_DIR=/var/lib/parashurama npm run user:add -w @parashurama/server -- nk.rao "Nk Arjun Rao" instructor "AD Troop 2"
```

## Threat packs (offline updates)

Doctrine and threat updates can arrive as signed `*.cuaspack.json` files, for example on USB.

1. **Install a pack:** Instructor panel → *Import signed threat pack*. Online, it becomes a new config version on the unit server; offline, it is saved in that browser.
2. **Rejection:** a pack is refused if any byte was changed, if it was signed by a key that is not trusted, or if its contents fail validation.

**Trusted keys** are listed in `config/trust/keys.json` and built into the app.

**Issuer setup (done once, on an offline machine):**
```bash
npm run pack:keygen -- DSSC dssc-2026 /secure/offline/dssc-2026.pem   # private key must be outside the repo
npm run pack:sign -- pack.json /secure/offline/dssc-2026.pem          # writes pack.cuaspack.json
```
`pack.json` contains `{ "meta": { "id", "version", "issuer", "date" }, "config": { "threats" | "effectors" | "doctrine" | "training" } }`.

## Backups and restore

- Manual: instructor panel → *Back up database now*, or `npm run backup -w @parashurama/server`.
- Restore: stop the server, replace `DATA_DIR/parashurama.db` with a backup file, start the server.

## Security notes

- **Sign-in is by name only, with no passwords.** Anyone who can reach the server can use any account by typing its name, including `admin`. Run the server only on a trusted unit network.
- Sessions are random tokens (only their SHA-256 is stored), 12-hour lifetime, `HttpOnly; SameSite=Strict` cookies (`Secure` under HTTPS).
- Sign-ins are rate-limited per address.
- Cross-origin state changes are refused; strict Content-Security-Policy with no `eval` (config validators are pre-compiled).
- Every drill is re-run on the server; a client cannot raise its own score. The decision log is SHA-256 chained.
- Sign-ins, self-created accounts, config changes, user creation, flagged drills and backups are recorded in the audit log (`/api/admin/audit`).
- The server needs no internet access.

## Updating doctrine files directly

Advanced: edit `config/*.json`, run `npm run validate:config`, rebuild. If you change anything in `config/schema/`, also run `npm run gen:validators`.
