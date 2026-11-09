#!/usr/bin/env bash
# Run this on the Raspberry Pi (not on the Sprite, not on the Mac).
# Turns this Linux box into a Tailscale exit node so Sprite Chrome can egress
# from home. The iMessage agent stays on the Fly Sprite — this Pi only routes.
set -euo pipefail

if [[ -d /.sprite || -d /home/sprite ]]; then
  echo "This looks like the Sprite. Run this on the Raspberry Pi." >&2
  exit 1
fi

if [[ "$(uname -s)" == Darwin ]]; then
  echo "This is a Mac. Use ./scripts/setup-macos-exit-node.sh instead." >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required." >&2
  exit 1
fi

MODEL=""
if [[ -r /proc/device-tree/model ]]; then
  MODEL="$(tr -d '\0' </proc/device-tree/model)"
fi
if [[ -n "$MODEL" ]]; then
  echo "Board: $MODEL"
fi

enable_ip_forwarding() {
  echo "Enabling IPv4/IPv6 forwarding (required for a Linux exit node)..."
  sudo tee /etc/sysctl.d/99-tailscale.conf >/dev/null <<'EOF'
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
EOF
  sudo sysctl -p /etc/sysctl.d/99-tailscale.conf >/dev/null
}

install_tailscale() {
  if command -v tailscale >/dev/null 2>&1 && command -v tailscaled >/dev/null 2>&1; then
    echo "tailscale already present: $(command -v tailscale)"
    return 0
  fi
  echo "Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "tailscale install did not leave tailscale on PATH." >&2
    exit 1
  fi
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "Installing python3 (used to read tailscale status)..."
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3
fi

install_tailscale
enable_ip_forwarding

UP_ARGS=(up --advertise-exit-node --ssh --accept-dns=false)
if [[ -n "${TS_HOSTNAME:-}" ]]; then
  UP_ARGS+=(--hostname="$TS_HOSTNAME")
fi

if sudo tailscale status >/dev/null 2>&1; then
  echo "Already logged in. Advertising this Pi as an exit node..."
  sudo tailscale set --advertise-exit-node
  sudo tailscale set --ssh
  if [[ -n "${TS_HOSTNAME:-}" ]]; then
    sudo tailscale set --hostname="$TS_HOSTNAME"
  fi
else
  echo "Starting Tailscale. If a login URL prints, open it on your phone and approve this Pi."
  sudo tailscale "${UP_ARGS[@]}"
fi

IDENTITY="$(sudo tailscale status --json | python3 -c 'import json,sys
d=json.load(sys.stdin)
self=d.get("Self") or {}
dns=(self.get("DNSName") or "").rstrip(".")
host=self.get("HostName") or ""
ips=self.get("TailscaleIPs") or []
ip4=next((i for i in ips if str(i).startswith("100.")), ips[0] if ips else "")
print(host)
print(dns)
print(ip4)
')"
HOST="$(printf '%s\n' "$IDENTITY" | sed -n '1p')"
DNS="$(printf '%s\n' "$IDENTITY" | sed -n '2p')"
IP4="$(printf '%s\n' "$IDENTITY" | sed -n '3p')"
NAME="${HOST:-$DNS}"

echo
echo "This Pi's Tailscale hostname:"
echo "  ${NAME:-unknown}"
if [[ -n "$DNS" && "$DNS" != "$NAME" ]]; then
  echo "MagicDNS name:"
  echo "  $DNS"
fi
echo "Tailscale IPv4:"
echo "  ${IP4:-unknown}"
echo
echo "Do these once:"
echo "  1. https://login.tailscale.com/admin/machines → this Pi → Edit route settings"
echo "     → Use as exit node."
echo "  2. Same machine menu → Disable key expiry (so it does not drop in 180 days)."
echo "  3. If TAILSCALE_AUTHKEY is not already in this repo's .env, generate a reusable,"
echo "     non-ephemeral auth key at https://login.tailscale.com/admin/settings/keys"
echo "     (that key is for the Sprite, not this Pi)."
echo "  4. In this repo's .env on the Mac (gitignored):"
echo "       TAILSCALE_EXIT_NODE=${NAME:-<hostname-or-100.x>}"
echo "     Keep the existing TAILSCALE_AUTHKEY. The Sprite looks up this name and"
echo "     uses the Pi's 100.x address."
echo "  5. ./scripts/provision.sh"
echo
echo "Leave this Pi powered on home internet (ethernet preferred). Re-run this script"
echo "anytime. Optional stable name: TS_HOSTNAME=rpi-home $0"
