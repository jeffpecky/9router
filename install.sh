#!/usr/bin/env bash
# Installs the 9router CLI globally on Linux/macOS from this repo checkout.
# Usage: ./install.sh   (needs npm and Node >= 18 on PATH)
# Builds the bundled app first (npm run cli:pack from the repo root), so the
# installed CLI always embeds the current source of the gateway.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$PKG_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "[9router] npm not found on PATH. Install Node.js first: https://nodejs.org" >&2
  exit 1
fi

echo "[9router] building CLI bundle (root npm install + build, ~9 min)..."
(
  cd "$REPO_ROOT"
  npm install --no-audit --no-fund
  npm run cli:pack
) # exits the script on failure via set -e

# npm pack --pack-destination .. drops the tgz next to cli/ in repo root.
TGZ="$(ls -t "$REPO_ROOT"/9router-*.tgz 2>/dev/null | head -n1 || true)"
if [ -z "$TGZ" ]; then
  echo "[9router] npm pack produced no 9router-*.tgz in $REPO_ROOT" >&2
  exit 1
fi

echo "[9router] installing global CLI from \"$TGZ\" ..."
# Linux/macOS swap files atomically, no kill needed. A running server keeps
# serving the OLD code from the old inode until restarted — remind, don't kill.
npm install -g "$TGZ"

if ! command -v 9router >/dev/null 2>&1; then
  echo "[9router] installed, but \"9router\" is not on PATH yet. Open a new terminal and run: 9router" >&2
  exit 0
fi
echo "[9router] done. If a 9router server was already running, restart it to pick up this version:"
echo "  pkill -f '9router/cli.js' ; 9router --skip-update -n -l"
