#!/usr/bin/env bash
# PARASHURAMA: set up and start (Linux / macOS).
#   ./setup.sh             install what is missing, build, start the unit server and open http://localhost:8080
#   ./setup.sh --offline   web app only, no unit server (http://localhost:5173)
#   Other options: --port N, --rebuild, --check (install and build only), --no-open
# Needs Node.js 22.5 or newer. If it is missing or too old, it is installed for this user with nvm (no sudo).
set -euo pipefail
cd "$(dirname "$0")"

NEED_MAJOR=22; NEED_MINOR=5
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>$NEED_MAJOR||(a===$NEED_MAJOR&&b>=$NEED_MINOR)?0:1)" 2>/dev/null
}

# Load nvm if it is already installed (a terminal that has not loaded it yet).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true

if ! node_ok; then
  if command -v node >/dev/null 2>&1; then
    echo "[setup] Node.js $(node -v) is too old; PARASHURAMA needs 22.5 or newer."
  else
    echo "[setup] Node.js is not installed."
  fi
  echo "[setup] Installing Node.js 22 for this user with nvm (https://github.com/nvm-sh/nvm)…"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    if command -v curl >/dev/null 2>&1; then curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    elif command -v wget >/dev/null 2>&1; then wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    else echo "[setup] Neither curl nor wget is available. Install Node.js 22 from https://nodejs.org and run ./setup.sh again."; exit 1; fi
    . "$NVM_DIR/nvm.sh"
  fi
  nvm install 22 && nvm use 22 >/dev/null
  node_ok || { echo "[setup] Node.js could not be installed. Install Node.js 22 from https://nodejs.org and run ./setup.sh again."; exit 1; }
fi
echo "[setup] Node.js $(node -v), npm $(npm -v)"

exec node scripts/setup.mjs "$@"
