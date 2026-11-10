#!/usr/bin/env bash
# Home box helper for pi-personal: Tailscale exit node, Sprite heartbeat ping,
# and cron routines that wake the Sprite with a prompt.
# Run on a Mac or a Raspberry Pi. The iMessage agent stays on the Fly Sprite.
#
#   ./scripts/install-home.sh            # install (standby unless grandfathered)
#   ./scripts/install-home.sh update     # copy scripts, keep role
#   ./scripts/install-home.sh register   # this box becomes the clock + exit node
#   ./scripts/install-home.sh standby    # demote this box; does not uninstall
#   ./scripts/install-home.sh uninstall
set -euo pipefail

CMD="${1:-install}"
ROOT="$(cd "$(dirname "$0")/.." && pwd 2>/dev/null || true)"
SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
if [[ "$SCRIPT_SOURCE" != /* ]]; then
  SCRIPT_SOURCE="$(pwd)/$SCRIPT_SOURCE"
fi
OS="$(uname -s)"
INTERVAL_DEFAULT=7200

if [[ -d /.sprite || -d /home/sprite ]]; then
  echo "This looks like the Sprite. Run this on the Mac or Raspberry Pi." >&2
  exit 1
fi

home_dir() {
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    eval echo "~$SUDO_USER"
  else
    echo "${HOME:-/root}"
  fi
}

HOME_DIR="$(home_dir)"
STATE_DIR="${PI_PERSONAL_HOME_DIR:-$HOME_DIR/.pi-personal-home}"
ENV_FILE="$STATE_DIR/env"
INSTALLED_SCRIPT="$STATE_DIR/install-home.sh"
INSTALLED_DAEMON="$STATE_DIR/home-daemon.py"
PLIST="$HOME_DIR/Library/LaunchAgents/com.pi-personal.home.plist"
LINUX_UNIT="/etc/systemd/system/pi-personal-home.service"
LINUX_ENV="/etc/pi-personal-home.env"

log() { echo "$*"; }
fail() { echo "$*" >&2; exit 1; }

load_env_file() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
}

find_and_load_env() {
  local candidate
  for candidate in \
    "${HOME_ENV:-}" \
    "$ENV_FILE" \
    "$LINUX_ENV" \
    "$(dirname "$SCRIPT_SOURCE")/env" \
    "$(dirname "$SCRIPT_SOURCE")/pi-personal-home.env"
  do
    [[ -n "$candidate" && -f "$candidate" ]] || continue
    load_env_file "$candidate"
    return 0
  done
  if [[ -n "${ROOT:-}" && -f "$ROOT/src/webhook.ts" && -f "$ROOT/.env" ]]; then
    load_env_file "$ROOT/.env"
    return 0
  fi
  return 1
}

tailscale_bin() {
  if command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
    return
  fi
  for candidate in /usr/bin/tailscale /usr/local/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  return 1
}

ts() {
  local bin
  bin="$(tailscale_bin)" || fail "tailscale is not installed."
  if [[ "$OS" == Linux && "$(id -u)" -eq 0 ]]; then
    "$bin" "$@"
  elif [[ "$OS" == Linux ]]; then
    sudo "$bin" "$@"
  else
    "$bin" "$@"
  fi
}

ensure_python() {
  command -v python3 >/dev/null 2>&1 && return 0
  [[ "$OS" == Linux ]] || return 0
  log "Installing python3 (used to read tailscale status)..."
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3
}

ensure_tailscale_installed() {
  if tailscale_bin >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$OS" == Darwin ]]; then
    fail "Install Tailscale first: brew install --cask tailscale
Then open Tailscale, sign in, and re-run ./scripts/install-home.sh"
  fi
  log "Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
  tailscale_bin >/dev/null 2>&1 || fail "tailscale install did not leave tailscale on PATH."
}

enable_linux_forwarding() {
  [[ "$OS" == Linux ]] || return 0
  log "Enabling IPv4/IPv6 forwarding for the exit node..."
  sudo tee /etc/sysctl.d/99-tailscale.conf >/dev/null <<'EOF'
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
EOF
  sudo sysctl -p /etc/sysctl.d/99-tailscale.conf >/dev/null
}

join_tailnet() {
  local up_args=(up --accept-dns=false)
  [[ "$OS" == Linux ]] && up_args+=(--ssh)
  if [[ -n "${TS_HOSTNAME:-}" ]]; then
    up_args+=(--hostname="$TS_HOSTNAME")
  fi
  if ts status >/dev/null 2>&1; then
    [[ "$OS" == Linux ]] && ts set --ssh >/dev/null || true
    if [[ -n "${TS_HOSTNAME:-}" ]]; then
      ts set --hostname="$TS_HOSTNAME" >/dev/null || true
    fi
  else
    log "Starting Tailscale. If a login URL prints, open it and approve this machine."
    ts "${up_args[@]}"
  fi
  if [[ "$(read_role)" == "active" ]]; then
    ts set --advertise-exit-node >/dev/null || true
  fi
}

print_exit_node_name() {
  ts status --json 2>/dev/null | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
except Exception:
  raise SystemExit(0)
self=d.get("Self") or {}
dns=(self.get("DNSName") or "").rstrip(".")
host=self.get("HostName") or ""
print(dns or host)
' 2>/dev/null || true
}

ROLE_FILE="$STATE_DIR/role"

write_env() {
  local sprite="${SPRITE_URL:-}"
  local secret="${HEARTBEAT_SECRET:-}"
  local interval="${HEARTBEAT_INTERVAL_SECONDS:-$INTERVAL_DEFAULT}"
  local port="${HOME_DAEMON_PORT:-8787}"
  local nodes="${HOME_NODES:-}"
  sprite="${sprite%/}"
  mkdir -p "$STATE_DIR"
  umask 077
  cat > "$ENV_FILE" <<EOF
SPRITE_URL=$sprite
HEARTBEAT_SECRET=$secret
HEARTBEAT_INTERVAL_SECONDS=$interval
HOME_DAEMON_PORT=$port
HOME_NODES=$nodes
EOF
  if [[ "$OS" == Linux && "$(id -u)" -eq 0 ]]; then
    cp "$ENV_FILE" "$LINUX_ENV"
    chmod 600 "$LINUX_ENV"
  fi
}

read_role() {
  [[ -f "$ROLE_FILE" ]] || return 0
  tr -d '[:space:]' < "$ROLE_FILE" | tr '[:upper:]' '[:lower:]'
}

write_role() {
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$1" > "$ROLE_FILE"
}

ensure_initial_role() {
  local existed_env="$1"
  if [[ -f "$ROLE_FILE" ]]; then
    return 0
  fi
  if [[ "$existed_env" == "1" ]]; then
    write_role "active"
    log "Existing home env had no role file; grandfathered as the active clock."
  else
    write_role "standby"
  fi
}

python_daemon() {
  local daemon_py="$INSTALLED_DAEMON"
  if [[ ! -f "$daemon_py" ]]; then
    daemon_py="$(dirname "$SCRIPT_SOURCE")/home-daemon.py"
  fi
  [[ -f "$daemon_py" ]] || fail "home-daemon.py is missing."
  export PI_PERSONAL_HOME_DIR="$STATE_DIR"
  python3 "$daemon_py" "$@"
}

restart_service() {
  if [[ "$OS" == Darwin ]]; then
    [[ -f "$PLIST" ]] || fail "Home daemon is not installed. Run ./scripts/install-home.sh first."
    launchctl kickstart -k "gui/$(id -u)/com.pi-personal.home" >/dev/null 2>&1 || true
  elif [[ "$OS" == Linux ]]; then
    [[ -f "$LINUX_UNIT" ]] || fail "Home daemon is not installed. Run sudo ./scripts/install-home.sh first."
    if [[ "$(id -u)" -eq 0 ]]; then
      systemctl restart pi-personal-home.service
    else
      sudo systemctl restart pi-personal-home.service
    fi
  else
    fail "Unsupported OS: $OS (Mac or Raspberry Pi Linux)."
  fi
}

install_script_copy() {
  mkdir -p "$STATE_DIR"
  cp "$SCRIPT_SOURCE" "$INSTALLED_SCRIPT"
  chmod 755 "$INSTALLED_SCRIPT"
  local daemon_src
  daemon_src="$(dirname "$SCRIPT_SOURCE")/home-daemon.py"
  if [[ -f "$daemon_src" ]]; then
    cp "$daemon_src" "$INSTALLED_DAEMON"
    chmod 755 "$INSTALLED_DAEMON"
  elif [[ -n "${ROOT:-}" && -f "$ROOT/scripts/home-daemon.py" ]]; then
    cp "$ROOT/scripts/home-daemon.py" "$INSTALLED_DAEMON"
    chmod 755 "$INSTALLED_DAEMON"
  else
    fail "home-daemon.py is missing next to install-home.sh."
  fi
}

install_launchd() {
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pi-personal.home</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALLED_SCRIPT</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>$STATE_DIR</string>
  <key>StandardOutPath</key>
  <string>$STATE_DIR/home.log</string>
  <key>StandardErrorPath</key>
  <string>$STATE_DIR/home.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/com.pi-personal.home" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl enable "gui/$(id -u)/com.pi-personal.home" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/$(id -u)/com.pi-personal.home" >/dev/null 2>&1 || true
}

install_systemd() {
  [[ "$(id -u)" -eq 0 ]] || fail "On Linux, re-run with sudo so the service survives reboot without a login."
  cat > "$LINUX_UNIT" <<EOF
[Unit]
Description=pi-personal home (Tailscale exit node + Sprite heartbeat + routines)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash $INSTALLED_SCRIPT daemon
WorkingDirectory=$STATE_DIR
EnvironmentFile=$LINUX_ENV
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now pi-personal-home.service
}

uninstall() {
  write_role "standby"
  if [[ "$OS" == Darwin ]]; then
    launchctl bootout "gui/$(id -u)/com.pi-personal.home" >/dev/null 2>&1 || true
    rm -f "$PLIST"
  elif [[ "$OS" == Linux ]]; then
    if [[ "$(id -u)" -eq 0 ]]; then
      systemctl disable --now pi-personal-home.service >/dev/null 2>&1 || true
      rm -f "$LINUX_UNIT" "$LINUX_ENV"
      systemctl daemon-reload >/dev/null 2>&1 || true
    else
      sudo systemctl disable --now pi-personal-home.service >/dev/null 2>&1 || true
      sudo rm -f "$LINUX_UNIT" "$LINUX_ENV"
      sudo systemctl daemon-reload >/dev/null 2>&1 || true
    fi
  fi
  log "Stopped the home daemon. Tailscale itself is still installed. This box is not the clock."
}

run_daemon() {
  find_and_load_env || true
  command -v python3 >/dev/null 2>&1 || fail "python3 is required for the home daemon scheduler."
  local daemon_py="$INSTALLED_DAEMON"
  if [[ ! -f "$daemon_py" ]]; then
    daemon_py="$(dirname "$SCRIPT_SOURCE")/home-daemon.py"
  fi
  [[ -f "$daemon_py" ]] || fail "home-daemon.py is missing."
  export PI_PERSONAL_HOME_DIR="$STATE_DIR"
  exec python3 "$daemon_py" daemon
}

install() {
  local existed_env=0
  [[ -f "$ENV_FILE" ]] && existed_env=1
  find_and_load_env || true
  ensure_python
  command -v python3 >/dev/null 2>&1 || fail "python3 is required for the home daemon scheduler."
  ensure_tailscale_installed
  enable_linux_forwarding
  write_env
  ensure_initial_role "$existed_env"
  join_tailnet
  install_script_copy
  if [[ "$OS" == Darwin ]]; then
    install_launchd
  elif [[ "$OS" == Linux ]]; then
    install_systemd
  else
    fail "Unsupported OS: $OS (Mac or Raspberry Pi Linux)."
  fi

  local name role
  name="$(print_exit_node_name)"
  role="$(read_role)"
  log
  if [[ "$role" == "active" ]]; then
    log "Home daemon is running as the registered clock (exit node + heartbeat + routines)."
  else
    log "Home daemon is installed in standby (Tailscale + HTTP API). It will not ping or fire crons."
    log "Make this the clock with: ./scripts/install-home.sh register"
  fi
  log "Code updates: ./scripts/install-home.sh update  (or ./scripts/provision.sh from the Mac)."
  if [[ -n "$name" ]]; then
    log
    log "Tailscale hostname: $name"
    log "Put TAILSCALE_AUTHKEY in the Sprite repo .env. After register, the Sprite stores the exit node in memory/home.json."
    log "Optional fallback: TAILSCALE_EXIT_NODE=$name"
  fi
  log
  log "Once per machine:"
  log "  1. https://login.tailscale.com/admin/machines → this machine → Use as exit node (needed when it is registered)"
  log "  2. Same menu → Disable key expiry"
  if [[ -z "${SPRITE_URL:-}" || -z "${HEARTBEAT_SECRET:-}" ]]; then
    log "  3. Set SPRITE_URL and HEARTBEAT_SECRET, then re-run install and register"
  fi
  if [[ "$OS" == Darwin ]]; then
    log
    log "To move the clock to a Raspberry Pi:"
    log "  scp $ENV_FILE $INSTALLED_SCRIPT $INSTALLED_DAEMON USER@raspberrypi.local:"
    log "  ssh USER@raspberrypi.local"
    log "  sudo bash install-home.sh"
    log "  sudo bash install-home.sh register"
  fi
}

update() {
  find_and_load_env || true
  ensure_python
  command -v python3 >/dev/null 2>&1 || fail "python3 is required for the home daemon scheduler."
  [[ -d "$STATE_DIR" ]] || fail "Home daemon is not installed. Run ./scripts/install-home.sh first."
  install_script_copy
  restart_service
  log "Updated home daemon scripts. Role unchanged ($(read_role || echo unknown))."
}

register_cmd() {
  find_and_load_env || true
  ensure_python
  command -v python3 >/dev/null 2>&1 || fail "python3 is required for the home daemon scheduler."
  [[ -f "$INSTALLED_DAEMON" || -f "$(dirname "$SCRIPT_SOURCE")/home-daemon.py" ]] || fail "Install first."
  python_daemon register
}

standby_cmd() {
  find_and_load_env || true
  ensure_python
  python_daemon standby
}

case "$CMD" in
  daemon) run_daemon ;;
  uninstall) uninstall ;;
  update) update ;;
  register) register_cmd ;;
  standby) standby_cmd ;;
  install|"") install ;;
  *) fail "Usage: $0 [install|update|register|standby|uninstall]" ;;
esac
