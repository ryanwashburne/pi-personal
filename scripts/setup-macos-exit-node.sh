#!/usr/bin/env bash
# Run this on the MacBook (not on the Sprite, not on the rpi).
# Turns this Mac into a Tailscale exit node so Sprite Chrome can egress from home.
# Later, do the same on the rpi and point TAILSCALE_EXIT_NODE at that name instead.
set -euo pipefail

if ! command -v tailscale >/dev/null 2>&1; then
  echo "Install Tailscale on this Mac first:"
  echo "  brew install --cask tailscale"
  echo "  open -a Tailscale"
  echo "Then sign in and re-run this script."
  echo "Or download: https://tailscale.com/download/mac"
  exit 1
fi

if ! tailscale status >/dev/null 2>&1; then
  echo "Tailscale is installed but not logged in. Open the Tailscale app, sign in, then re-run."
  exit 1
fi

echo "Advertising this Mac as an exit node..."
tailscale set --advertise-exit-node

NAME="$(tailscale status --json | python3 -c 'import json,sys
d=json.load(sys.stdin)
self=d.get("Self") or {}
dns=(self.get("DNSName") or "").rstrip(".")
host=self.get("HostName") or ""
print(dns or host)
')"

echo
echo "This Mac's Tailscale name:"
echo "  $NAME"
echo
echo "Do these once:"
echo "  1. Tailscale menu bar → this Mac → enable Run as exit node if it is not already."
echo "  2. https://login.tailscale.com/admin/machines → this Mac → Enable as exit node."
echo "  3. https://login.tailscale.com/admin/settings/keys → Generate auth key"
echo "     (reusable, not ephemeral)."
echo "  4. In this repo's .env (gitignored):"
echo "       TAILSCALE_AUTHKEY=tskey-auth-..."
echo "       TAILSCALE_EXIT_NODE=$NAME"
echo "  5. ./scripts/provision.sh"
echo
echo "Leave this Mac awake on home internet while you test."
echo "When the rpi is ready: advertise it as an exit node, approve it, set"
echo "TAILSCALE_EXIT_NODE to the rpi name, re-run provision. The Sprite does not care"
echo "which machine is the exit node."
