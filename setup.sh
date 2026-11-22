#!/usr/bin/env bash
# PARASHURAMA: set up and start (Linux / macOS). The Windows twin is setup.bat; both do the same steps.
#   ./setup.sh             install what is missing, build, start the unit server and open http://localhost:8080
#   ./setup.sh --offline   web app only, no unit server (http://localhost:5173)
#   Other options: --port N, --rebuild, --check (install and build only), --no-open, --keep-running,
#                  --update (pull the latest code first)
# This one file is enough: run on its own, it gets the project first (Git clone, or a GitHub download without Git).
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

# ---------- 0. The project itself ----------
# Run on its own (downloaded without the project), this file fetches the project into ./parashurama and runs the
# project's own setup.sh: with Git if it is installed (a shallow clone; later runs update it), otherwise as a
# GitHub archive (no Git needed). Inside the project, --update pulls the latest code first.
REPO_URL="https://github.com/Babanstar456/parashurama.git"
REPO_TGZ="https://codeload.github.com/Babanstar456/parashurama/tar.gz/refs/heads/main"
git_ok() {
  [ "${PARASHURAMA_NO_GIT:-}" = "1" ] && return 1 # testing: behave as if Git were missing
  command -v git >/dev/null 2>&1 || return 1
  local v; v="$(git --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+)\.([0-9]+).*/\1 \2/')"
  [ "${v%% *}" -ge 2 ] 2>/dev/null
}
if [ ! -f "$ROOT/package.json" ] || [ ! -f "$ROOT/scripts/setup.mjs" ]; then
  DEST="${PARASHURAMA_DIR:-$ROOT/parashurama}"
  if [ -d "$DEST/.git" ] && git_ok; then
    echo "[setup] Updating the project in $DEST ($(git --version))…"
    git -C "$DEST" pull --ff-only || echo "[setup] Could not update (offline, or local changes): using the copy as it is."
  elif [ -f "$DEST/scripts/setup.mjs" ]; then
    echo "[setup] Using the project in $DEST."
  elif git_ok; then
    echo "[setup] $(git --version) found: cloning the project into $DEST…"
    git clone --depth 1 "$REPO_URL" "$DEST" || { echo "[setup] Clone failed. Check the internet connection and run this again."; exit 1; }
  else
    if [ "${PARASHURAMA_NO_GIT:-}" = "1" ]; then echo "[setup] Git not used (PARASHURAMA_NO_GIT=1): downloading the project without Git."
    elif command -v git >/dev/null 2>&1; then echo "[setup] $(git --version) is too old (2.0 or newer needed): downloading the project without Git."
    else echo "[setup] Git is not installed: downloading the project without Git (later runs download it again only if it is missing)."; fi
    mkdir -p "$DEST"
    fetch "$REPO_TGZ" | tar -xz -C "$DEST" --strip-components=1 || { echo "[setup] Download failed. Check the internet connection and run this again."; exit 1; }
  fi
  chmod +x "$DEST/setup.sh"
  echo "[setup] Starting the project's setup in $DEST."
  exec "$DEST/setup.sh" "$@"
fi
for a in "$@"; do
  if [ "$a" = "--update" ]; then
    if [ -d "$ROOT/.git" ] && git_ok; then echo "[setup] --update: pulling the latest code…"; git -C "$ROOT" pull --ff-only || echo "[setup] Could not update (offline, or local changes): continuing with this copy."
    else echo "[setup] --update needs a Git clone of the project: skipped."; fi
  fi
done

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
