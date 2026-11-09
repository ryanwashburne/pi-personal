#!/usr/bin/env bash
# Installs the Tailscale client on the Sprite. The daemon is started by the gateway
# in userspace mode so Sendblue/webhooks stay on Fly and only Chrome uses the SOCKS proxy.
set -euo pipefail

if command -v tailscale >/dev/null 2>&1 && command -v tailscaled >/dev/null 2>&1; then
  echo "tailscale already present: $(command -v tailscale)"
  exit 0
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo not available; install tailscale on the Sprite by hand." >&2
  exit 0
fi

curl -fsSL https://tailscale.com/install.sh | sh
# Sprite services, not systemd, run our userspace daemon. Stop the default one if it started.
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl stop tailscaled 2>/dev/null || true
  sudo systemctl disable tailscaled 2>/dev/null || true
fi

if ! command -v tailscale >/dev/null 2>&1 || ! command -v tailscaled >/dev/null 2>&1; then
  echo "tailscale install did not leave tailscale/tailscaled on PATH." >&2
  exit 1
fi
echo "tailscale ready: $(command -v tailscale)"
