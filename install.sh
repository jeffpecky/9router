#!/usr/bin/env bash
# Installs the 9router CLI globally on Linux/macOS from this repo checkout.
#
# Everything user-facing runs AS YOU — build, npm pack, global install into
# your own npm prefix (nvm or ~/.npm-global) — mirroring the Windows path,
# where there is nothing root about it. Only the final systemd unit write
# needs root, and even then the SERVICE still runs as the invoking user.
#
# Usage: ./install.sh                # user install, no systemd step
#        sudo bash install.sh        # user install + systemd service
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$PKG_DIR"

# The build+install phase must run as the invoking user, never root. Under
# sudo, those steps delegate back to the sudoer via `su` (which also brings
# the user's nvm PATH — root's secure_path never touches them). Only the
# /etc/unit writes at the end run with root privileges.
# npm-corner: `su $SUDO_USER -c` does NOT source .bashrc, so an nvm-managed
# npm is invisible inside the delegate too. Discover the bin path directly
# from the user's home nvm dir; npm may equally be a plain /usr/bin binary.
if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ]; then
  USER_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  NODE_BIN="$(ls -td "$USER_HOME"/.nvm/versions/node/v*/bin 2>/dev/null | head -n1 || true)"
fi

# run_as_user executes the command as the invoking user with the discovered
# node/npm prepended to PATH, so nvm-installed npm is findable regardless of
# how su shells are sourced.
run_as_user() {
  if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ]; then
    PATH_SUFFIX=""
    if [ -n "${NODE_BIN:-}" ]; then PATH_SUFFIX="PATH=$NODE_BIN:\$PATH "; fi
    su -s /bin/bash -- "$SUDO_USER" -c "cd '$(pwd)' && export ${PATH_SUFFIX}HOME=$USER_HOME; $*"
  else
    "$@"
  fi
}

# Everything after here runs build/install as the invoking user via
# run_as_user; under sudo that's also where npm comes from (the user's own
# nvm PATH — no re-exec needed, root's secure_path never enters the picture
# for those steps). Only root runs the /etc/unit writes at the end.
if ! run_as_user command -v npm >/dev/null 2>&1; then
  echo "[9router] npm not found on PATH. Install Node.js first: https://nodejs.org" >&2
  exit 1
fi

echo "[9router] building CLI bundle (~10 min, as $(id -un))..."
(
  cd "$REPO_ROOT"
  run_as_user npm install --no-audit --no-fund
  cd cli
  run_as_user npm install --no-audit --no-fund   # esbuild lives in cli/devDependencies; build-cli/buildMitm require it
  cd ..
  run_as_user npm run cli:pack
) # exits the script on failure via set -e

# npm pack --pack-destination .. drops the tgz next to cli/ in repo root.
TGZ="$(ls -t "$REPO_ROOT"/9router-*.tgz 2>/dev/null | head -n1 || true)"
if [ -z "$TGZ" ]; then
  echo "[9router] npm pack produced no 9router-*.tgz in $REPO_ROOT" >&2
  exit 1
fi

echo "[9router] installing global CLI into \$(npm prefix -g) as $(id -un) ..."
# Linux/macOS swap files atomically, no kill needed. A running server keeps
# serving the OLD code from the old inode until restarted — remind, don't kill.
# Runs as the invoking user: the binary lands in the user's own npm prefix
# (nvm or ~/.npm-global), matching Windows behavior — not root's /usr/local.
run_as_user npm install -g "$TGZ"

if ! run_as_user command -v 9router >/dev/null 2>&1; then
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
# Known daemonization issues (decolua/9router#2490): logs written synchronously
# into a systemd pipe can fill the buffer and stall the node event loop →
# crash loop ("Exiting..." repeating, API timeouts). journald drains async
# under normal load; LogRateLimitIntervalSec=0 keeps it from dropping lines,
# so we keep logs instead of the StandardOutput=null that loses them all.
# --skip-update: update check made the service exit 0 mid-run (same issue).
# -n: no browser. -l intentionally omitted: that flag toggles verbose console
# log consumption, which is exactly the pipe-filling path we are avoiding.
# ExecStart resolves the 9router binary under the SERVICE user's PATH (nvm
# prefix), not root's — command -v under run_as_user.
NINEROUTER_BIN="$(run_as_user sh -c 'command -v 9router' || true)"
if [ -z "$NINEROUTER_BIN" ]; then
  echo "[9router] cannot resolve the 9router binary for ExecStart; install first." >&2
  exit 1
fi
cat > "$UNIT" <<UNIT
[Unit]
Description=9Router AI gateway
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
Environment=HOME=/home/$SERVICE_USER
Environment=NODE_ENV=production
ExecStart=$NINEROUTER_BIN --skip-update -n
Restart=on-failure
RestartSec=5
# node and its tray/sqlite runtime children die with the service
KillMode=control-group
TimeoutStopSec=15
# decolua/9router#2490: keep journald draining (no drops) so node's sync
# stdout writes never block on a rate-limited queue.
LogRateLimitIntervalSec=0
LogRateLimitBurst=0

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
