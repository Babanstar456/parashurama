#!/usr/bin/env bash
# PARASHURAMA: set up and start (Linux / macOS). The Windows twin is setup.bat; both do the same steps.
#   ./setup.sh             install what is missing, build, start the unit server and open http://localhost:8080
#   ./setup.sh --offline   web app only, no unit server (http://localhost:5173)
#   Other options: --port N, --rebuild, --check (install and build only), --no-open, --keep-running
# Node.js 22.5 or newer is needed. Order: a portable copy in .node/ inside this folder, then the system's Node.js;
# if neither fits (missing or too old), the official Node.js 22 for this computer is downloaded from nodejs.org into
# .node/ and its SHA-256 checksum is verified. No administrator rights, nothing installed system-wide.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

# Do not run with sudo: nothing here needs administrator rights, files written as root break later normal runs,
# and a root process cannot open the browser in your desktop session.
if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ]; then
  echo "[setup] Please run it without sudo:   ./setup.sh"
  echo "[setup] Nothing in the setup needs administrator rights, and as root it cannot open your browser."
  exit 1
fi

NEED_MAJOR=22; NEED_MINOR=5
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>$NEED_MAJOR||(a===$NEED_MAJOR&&b>=$NEED_MINOR)?0:1)" 2>/dev/null
}
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"; else return 9; fi; }

# 1. A portable Node.js from an earlier run.
[ -x "$ROOT/.node/bin/node" ] && export PATH="$ROOT/.node/bin:$PATH"
# 2. The system's Node.js (also one installed with nvm, if this terminal has not loaded nvm yet).
if ! node_ok && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1 || true; fi
# 3. Download the official Node.js 22 into .node/ (PARASHURAMA_FORCE_NODE_DOWNLOAD=1 forces this, for testing).
if ! node_ok || [ "${PARASHURAMA_FORCE_NODE_DOWNLOAD:-}" = "1" ]; then
  if command -v node >/dev/null 2>&1 && [ "${PARASHURAMA_FORCE_NODE_DOWNLOAD:-}" != "1" ]; then echo "[setup] Node.js $(node -v) is too old; PARASHURAMA needs $NEED_MAJOR.$NEED_MINOR or newer."
  else echo "[setup] Node.js $NEED_MAJOR.$NEED_MINOR or newer was not found."; fi
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "[setup] Unsupported system $(uname -s): install Node.js 22 from https://nodejs.org"; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; armv7l) arch=armv7l ;; *) echo "[setup] Unsupported processor $(uname -m): install Node.js 22 from https://nodejs.org"; exit 1 ;; esac
  base="https://nodejs.org/dist/latest-v22.x"
  echo "[setup] Downloading the official Node.js 22 for $os-$arch into .node/ (no administrator rights needed)…"
  sums="$(fetch "$base/SHASUMS256.txt")" || { echo "[setup] Could not reach nodejs.org (internet needed once). Or install Node.js 22 from https://nodejs.org"; exit 1; }
  line="$(printf '%s\n' "$sums" | grep -E "  node-v22\.[0-9]+\.[0-9]+-$os-$arch\.tar\.gz$" | head -1)"
  [ -n "$line" ] || { echo "[setup] No Node.js 22 download for $os-$arch. Install it from https://nodejs.org"; exit 1; }
  sum="${line%% *}"; file="${line##* }"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  fetch "$base/$file" > "$tmp/$file" || { echo "[setup] Download failed. Check the internet connection and run ./setup.sh again."; exit 1; }
  if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$file" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)"; fi
  [ "$got" = "$sum" ] || { echo "[setup] Checksum mismatch for $file: download not used. Run ./setup.sh again."; exit 1; }
  rm -rf "$ROOT/.node"; mkdir -p "$ROOT/.node"
  tar -xzf "$tmp/$file" -C "$ROOT/.node" --strip-components=1
  export PATH="$ROOT/.node/bin:$PATH"; hash -r
  node_ok || { echo "[setup] The downloaded Node.js does not run here. Install Node.js 22 from https://nodejs.org"; exit 1; }
  echo "[setup] Node.js installed in .node/ (checksum verified)."
fi
echo "[setup] Node.js $(node -v), npm $(npm -v)"

exec node scripts/setup.mjs "$@"
