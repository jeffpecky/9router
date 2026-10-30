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

# --- systemd service (Linux, background run) ------------------------------
# Only when running as root via sudo: writing /etc/systemd/system needs it.
# User= is set from the invoking sudoer so the service reads ~/.9router
# (db, tokens) — a root-run instance would silently read /root/.9router and
# miss all dashboard-configured credentials. macOS has no systemd: skipped.
if ! command -v systemctl >/dev/null 2>&1; then
  echo "[9router] systemd not found (macOS?), skipping service install."
  exit 0
fi
SERVICE_USER="${SUDO_USER:-$(logname 2>/dev/null || echo '')}"
if [ "$(id -u)" -ne 0 ] || [ -z "$SERVICE_USER" ]; then
  echo "[9router] run with sudo to also install the systemd service (e.g. sudo ./install.sh)"
  exit 0
fi

UNIT=/etc/systemd/system/9router.service
# -nir: no browser, no log-spam, --skip-update so systemd-started instance
#       won't fight manual dev runs; port/host default (20128 / 0.0.0.0).
cat > "$UNIT" <<UNIT
[Unit]
Description=9Router AI gateway
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
Environment=HOME=/home/$SERVICE_USER
ExecStart=$(command -v 9router) --skip-update -n -l
Restart=on-failure
RestartSec=5
# node and its tray/sqlite runtime children die with the service
KillMode=control-group
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
# A manually-started server holds :20128 and would make the service exit
# immediately (Restart=on-failure would then loop). Stop the manual one;
# systemd's copy takes over the port.
pkill -f '9router/cli.js' 2>/dev/null || true
sleep 1
# enable --now: boots on startup AND starts immediately; is-active then
# confirms systemd actually has it up, not just registered.
systemctl enable --now 9router.service
sleep 2
if systemctl is-active --quiet 9router; then
  echo "[9router] systemd service installed and running."
  echo "[9router] status: systemctl status 9router | logs: journalctl -u 9router -f"
else
  echo "[9router] WARNING: service registered but not active — check:"
  echo "  systemctl status 9router ; journalctl -u 9router -n 50 --no-pager"
fi
