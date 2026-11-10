#!/usr/bin/env bash
# Back-compat: same as ./scripts/install-home.sh on a Raspberry Pi.
exec "$(cd "$(dirname "$0")" && pwd)/install-home.sh" "$@"
