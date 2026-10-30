#!/usr/bin/env bash
# Installs the 9router CLI globally on Linux/macOS from this repo checkout.
#
# Structure: this script ALWAYS runs as the invoking user (build, pack, and
# the global npm install go into YOUR npm prefix, like Windows). It never
# drops root privileges mid-flight via su/sudo -u — that is what every
# previous iteration tripped on (su is PAM-dependent, non-login shells skip
# .bashrc so nvm is invisible, silent fallbacks ran the wrong identity).
# When root is needed for exactly two things — writing the systemd unit and
# restarting it under your name — the script re-execs just those actions via
# plain sudo, passing explicit arguments (no shell interpolation games).
#
# Usage: ./install.sh                # user install; prints the sudo commands
#                                    # for the service step, no prompts
#        sudo bash install.sh        # full install INCLUDING the service
#                                    # (user steps re-execute user-side, the
#                                    # unit write is the only root action)
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$PKG_DIR"

# If a user ran this via sudo, run everything as that user again: re-exec
# WITHOUT sudo, remembering that the service step is authorized. This is the
# key trick — the heavy work never runs as root, and there is no root→user
# delegation inside the script at all.
NEED_SERVICE=0
if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ] && [ "${NINEROUTER_INSTALLING:-}" != "1" ]; then
  # Drop out of root for the user phases, then use sudo only for the unit.
  # sudo -u accepts a NAME or a #UID; some sudoers plugins reject #name.
  exec sudo -u "$SUDO_USER" \
    env NINEROUTER_INSTALLING=1 NINEROUTER_SERVICE_USER="$SUDO_USER" \
    NINEROUTER_ORIG_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)" \
    bash "$0" "$@"
fi
if [ "${NINEROUTER_INSTALLING:-}" = "1" ]; then
  NEED_SERVICE=1
  SERVICE_USER="${NINEROUTER_SERVICE_USER:-}"
  USER_HOME="${NINEROUTER_ORIG_HOME:-}"
else
  SERVICE_USER="${SUDO_USER:-$(logname 2>/dev/null || echo '')}"
  USER_HOME="$(getent passwd "${SERVICE_USER:-$USER}" 2>/dev/null | cut -d: -f6 || true)"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[9router] npm not found on PATH. Install Node.js first: https://nodejs.org" >&2
  exit 1
fi

echo "[9router] building CLI bundle (~10 min, as $(id -un))..."
(
  cd "$REPO_ROOT"
  npm install --no-audit --no-fund
  cd cli
  npm install --no-audit --no-fund   # esbuild lives in cli/devDependencies; build-cli/buildMitm require it
  cd ..
  npm run cli:pack
) # exits the script on failure via set -e

TGZ="$(ls -t "$REPO_ROOT"/9router-*.tgz 2>/dev/null | head -n1 || true)"
if [ -z "$TGZ" ]; then
  echo "[9router] npm pack produced no 9router-*.tgz in $REPO_ROOT" >&2
  exit 1
fi

echo "[9router] installing global CLI into \$(npm prefix -g) as $(id -un) ..."
# A running server keeps serving the OLD code from the old inode until
# restarted — remind, don't kill. The binary lands in your own npm prefix
# (nvm or ~/.npm-global), never root's.
npm install -g "$TGZ"

if ! command -v 9router >/dev/null 2>&1; then
  echo "[9router] installed, but \"9router\" is not on PATH yet. Open a new terminal and run: 9router" >&2
  exit 0
fi
echo "[9router] done. If a 9router server was already running, restart it to pick up this version:"
echo "  pkill -f '9router/cli.js' ; 9router --skip-update -n -l"

# --- systemd service (Linux) ----------------------------------------------
# Root needed only here. When the top re-exec happened (NEED_SERVICE=1), the
# invoking sudo authorization is still active, but we are now user-side — so
# shell out to `sudo` for just the unit write, with every value explicit.
if ! command -v systemctl >/dev/null 2>&1; then
  echo "[9router] systemd not found (macOS?), skipping service install."
  exit 0
fi
NINEROUTER_BIN="$(command -v 9router || true)"
if [ -z "$NINEROUTER_BIN" ]; then
  echo "[9router] cannot resolve the 9router binary for ExecStart; install first." >&2
  exit 1
fi
echo "[9router] ExecStart binary: $NINEROUTER_BIN"

UNIT_BODY=$(cat <<UNIT_BODY
[Unit]
Description=9Router AI gateway
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
Environment=HOME=$USER_HOME
Environment=NODE_ENV=production
ExecStart=$NINEROUTER_BIN --skip-update -n
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=15
# decolua/9router#2490: keep journald draining (no drops) so node's sync
# stdout writes never block on a rate-limited queue.
LogRateLimitIntervalSec=0
LogRateLimitBurst=0

[Install]
WantedBy=multi-user.target
UNIT_BODY
)

do_service_install() {
  # Runs as the invoking user either way; asks sudo to do the privileged bits.
  echo "$UNIT_BODY" | sudo tee /etc/systemd/system/9router.service >/dev/null
  sudo systemctl daemon-reload
  # A manually-started server holds :20128 and would crash-loop the unit.
  sudo pkill -f '9router/cli.js' 2>/dev/null || true
  sleep 1
  sudo systemctl enable --now 9router.service
  sleep 2
  if systemctl is-active --quiet 9router; then
    echo "[9router] systemd service installed and running."
    echo "[9router] status: systemctl status 9router | logs: journalctl -u 9router -f"
  else
    echo "[9router] WARNING: service registered but not active — check:"
    echo "  systemctl status 9router ; journalctl -u 9router -n 50 --no-pager"
  fi
}

if [ "$NEED_SERVICE" = "1" ]; then
  do_service_install
else
  echo "[9router] to ALSO install the systemd service, run:  sudo bash $0"
fi
