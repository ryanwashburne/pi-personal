#!/usr/bin/env bash
# Push home-daemon scripts to this machine and every HOME_NODES host.
# Does not change who is registered as the clock.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="${1:-}"
if [[ "$CMD" == "daemon" ]]; then
  echo "sync-home.sh does not run the daemon. Use install-home.sh." >&2
  exit 1
fi

if [[ -d /.sprite || -d /home/sprite ]]; then
  echo "Skipping home-daemon sync (this looks like the Sprite)."
  exit 0
fi

STATE_DIR="${PI_PERSONAL_HOME_DIR:-$HOME/.pi-personal-home}"
INSTALLER="$ROOT/scripts/install-home.sh"
DAEMON="$ROOT/scripts/home-daemon.py"

if [[ ! -f "$INSTALLER" || ! -f "$DAEMON" ]]; then
  echo "Missing $INSTALLER or $DAEMON" >&2
  exit 1
fi

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

log() { echo "$*"; }

local_tailscale_name() {
  local bin=""
  if command -v tailscale >/dev/null 2>&1; then
    bin="$(command -v tailscale)"
  elif [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
    bin="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  else
    return 0
  fi
  "$bin" status --json 2>/dev/null | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
except Exception:
  raise SystemExit(0)
self=d.get("Self") or {}
host=(self.get("HostName") or "").strip().lower()
dns=(self.get("DNSName") or "").rstrip(".").split(".")[0].lower()
print(host or dns)
' 2>/dev/null || true
}

same_host() {
  local want="$1"
  local local_name="$2"
  local short
  want="$(printf '%s' "$want" | tr '[:upper:]' '[:lower:]')"
  want="${want%%.*}"
  short="$(hostname -s 2>/dev/null || hostname || true)"
  short="$(printf '%s' "$short" | tr '[:upper:]' '[:lower:]')"
  local_name="$(printf '%s' "$local_name" | tr '[:upper:]' '[:lower:]')"
  [[ -n "$want" ]] || return 1
  [[ "$want" == "$short" || "$want" == "$local_name" ]]
}

update_local() {
  if [[ ! -d "$STATE_DIR" ]]; then
    log "No $STATE_DIR; skipping local home-daemon update."
    return 0
  fi
  log "Updating local home daemon (role unchanged)..."
  bash "$INSTALLER" update
}

update_remote() {
  local host="$1"
  if ! command -v tailscale >/dev/null 2>&1 && [[ ! -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
    log "tailscale CLI missing; cannot update $host"
    return 0
  fi
  local ts="tailscale"
  [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]] && ! command -v tailscale >/dev/null 2>&1 && ts="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  log "Updating home daemon on $host..."
  if ! tar -czf - -C "$ROOT/scripts" install-home.sh home-daemon.py |
    "$ts" ssh "$host" -- bash -lc 'set -euo pipefail
dir="${PI_PERSONAL_HOME_DIR:-$HOME/.pi-personal-home}"
mkdir -p "$dir"
tar -xzf - -C "$dir"
chmod 755 "$dir/install-home.sh" "$dir/home-daemon.py"
if [[ "$(uname -s)" == Linux ]]; then
  sudo bash "$dir/install-home.sh" update
else
  bash "$dir/install-home.sh" update
fi
'; then
    log "Warning: could not update $host (is Tailscale SSH on, and is the host in HOME_NODES?)"
  fi
}

update_local
LOCAL_TS="$(local_tailscale_name)"
NODES=()
if [[ -n "${HOME_NODES:-}" ]]; then
  IFS=',' read -r -a NODES <<< "$HOME_NODES"
fi
for raw in "${NODES[@]}"; do
  node="$(echo "$raw" | tr -d '[:space:]')"
  [[ -n "$node" ]] || continue
  if same_host "$node" "$LOCAL_TS"; then
    continue
  fi
  update_remote "$node"
done
