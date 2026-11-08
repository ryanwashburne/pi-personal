#!/usr/bin/env bash
set -euo pipefail

if ! command -v sprite >/dev/null 2>&1; then
  echo "Installing Fly Sprites CLI..."
  curl -fsSL https://sprites.dev/install.sh | bash
  export PATH="${HOME}/.local/bin:${PATH}"
fi

if ! command -v pi >/dev/null 2>&1; then
  echo "Installing Pi CLI (useful for local checks; the Sprite already has it)..."
  curl -fsSL https://pi.dev/install.sh | sh
fi

echo
echo "Next:"
echo "  sprite login"
echo "  cp .env.example .env   # fill Sendblue keys, numbers, secrets, model key"
echo "  ./scripts/provision.sh"
