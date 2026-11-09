#!/usr/bin/env bash
# Home box helper for pi-personal: Tailscale exit node + Sprite heartbeat ping.
# Run on a Mac or a Raspberry Pi. The iMessage agent stays on the Fly Sprite.
#
#   ./scripts/install-home.sh            # install or update
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

advertise_exit_node() {
  local up_args=(up --advertise-exit-node --accept-dns=false)
  [[ "$OS" == Linux ]] && up_args+=(--ssh)
  if [[ -n "${TS_HOSTNAME:-}" ]]; then
    up_args+=(--hostname="$TS_HOSTNAME")
  fi
  if ts status >/dev/null 2>&1; then
    ts set --advertise-exit-node >/dev/null
    [[ "$OS" == Linux ]] && ts set --ssh >/dev/null || true
    if [[ -n "${TS_HOSTNAME:-}" ]]; then
      ts set --hostname="$TS_HOSTNAME" >/dev/null || true
    fi
  else
    log "Starting Tailscale. If a login URL prints, open it and approve this machine."
    ts "${up_args[@]}"
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

write_env() {
  local sprite="${SPRITE_URL:-}"
  local secret="${HEARTBEAT_SECRET:-}"
  local interval="${HEARTBEAT_INTERVAL_SECONDS:-$INTERVAL_DEFAULT}"
  sprite="${sprite%/}"
  mkdir -p "$STATE_DIR"
  umask 077
  cat > "$ENV_FILE" <<EOF
SPRITE_URL=$sprite
HEARTBEAT_SECRET=$secret
HEARTBEAT_INTERVAL_SECONDS=$interval
EOF
  if [[ "$OS" == Linux && "$(id -u)" -eq 0 ]]; then
    cp "$ENV_FILE" "$LINUX_ENV"
    chmod 600 "$LINUX_ENV"
  fi
}

install_script_copy() {
  mkdir -p "$STATE_DIR"
  cp "$SCRIPT_SOURCE" "$INSTALLED_SCRIPT"
  chmod 755 "$INSTALLED_SCRIPT"
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
Description=pi-personal home (Tailscale exit node + Sprite heartbeat)
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
  log "Stopped the home daemon. Tailscale itself is still installed."
}

ping_heartbeat() {
  local sprite="${SPRITE_URL:-}"
  local secret="${HEARTBEAT_SECRET:-}"
  sprite="${sprite%/}"
  if [[ -z "$sprite" || -z "$secret" ]]; then
    log "heartbeat skipped (set SPRITE_URL and HEARTBEAT_SECRET, then re-run install)"
    return 0
  fi
  local code
  code="$(curl -sS -o /tmp/pi-personal-heartbeat-body -w "%{http_code}" --max-time 600 "$sprite/heartbeat/$secret" || true)"
  case "$code" in
    200) log "heartbeat $(tr -d '\n' </tmp/pi-personal-heartbeat-body 2>/dev/null || echo ok)" ;;
    "") log "heartbeat failed (curl error)" ;;
    *) log "heartbeat HTTP $code" ;;
  esac
}

run_daemon() {
  find_and_load_env || true
  local interval="${HEARTBEAT_INTERVAL_SECONDS:-$INTERVAL_DEFAULT}"
  [[ "$interval" =~ ^[0-9]+$ ]] || interval="$INTERVAL_DEFAULT"
  while true; do
    if tailscale_bin >/dev/null 2>&1; then
      ts set --advertise-exit-node >/dev/null 2>&1 || log "tailscale advertise failed"
    else
      log "tailscale missing"
    fi
    ping_heartbeat
    sleep "$interval"
  done
}

install() {
  find_and_load_env || true
  ensure_python
  ensure_tailscale_installed
  enable_linux_forwarding
  advertise_exit_node
  write_env
  install_script_copy
  if [[ "$OS" == Darwin ]]; then
    install_launchd
  elif [[ "$OS" == Linux ]]; then
    install_systemd
  else
    fail "Unsupported OS: $OS (Mac or Raspberry Pi Linux)."
  fi

  local name
  name="$(print_exit_node_name)"
  log
  log "Home daemon is running (exit node + heartbeat ping)."
  log "Re-run this script to update it."
  if [[ -n "$name" ]]; then
    log
    log "In the Sprite repo .env on the Mac (gitignored):"
    log "  TAILSCALE_EXIT_NODE=$name"
    log "Keep TAILSCALE_AUTHKEY. Re-run ./scripts/provision.sh after changing it."
  fi
  log
  log "Once:"
  log "  1. https://login.tailscale.com/admin/machines → this machine → Use as exit node"
  log "  2. Same menu → Disable key expiry"
  if [[ -z "${SPRITE_URL:-}" || -z "${HEARTBEAT_SECRET:-}" ]]; then
    log "  3. Set SPRITE_URL and HEARTBEAT_SECRET (provision.sh prints the heartbeat URL) and re-run this script"
  else
    log "  Heartbeat ping is on. Leave this machine powered on home internet."
  fi
  if [[ "$OS" == Darwin ]]; then
    log
    log "To move this to a Raspberry Pi:"
    log "  scp $ENV_FILE $INSTALLED_SCRIPT USER@raspberrypi.local:"
    log "  ssh USER@raspberrypi.local"
    log "  sudo bash install-home.sh"
  fi
}

case "$CMD" in
  daemon) run_daemon ;;
  uninstall) uninstall ;;
  install|"") install ;;
  *) fail "Usage: $0 [install|uninstall]" ;;
esac
