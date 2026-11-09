#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SPRITE_NAME="${SPRITE_NAME:-pi-personal}"
REMOTE_APP="/home/sprite/pi-personal"
REMOTE_AGENT="/home/sprite/agent"

if [[ ! -f .env ]]; then
  echo "Create .env from .env.example first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

: "${WEBHOOK_PATH_SECRET:?WEBHOOK_PATH_SECRET must be set in .env}"
: "${SENDBLUE_API_KEY_ID:?}"
: "${SENDBLUE_API_KEY_SECRET:?}"
: "${SENDBLUE_WEBHOOK_SECRET:?}"

# Sprite CLI uses SPRITE_URL as its API endpoint. .env uses the same name
# for the public VM origin, so drop it before calling `sprite`.
unset SPRITE_URL

if ! command -v sprite >/dev/null 2>&1; then
  echo "sprite CLI not found. Run ./scripts/install-clis.sh then sprite login." >&2
  exit 1
fi

if ! sprite list >/dev/null 2>&1; then
  echo "sprite is installed but not logged in. Run: sprite login" >&2
  exit 1
fi

if sprite list | grep -q "$SPRITE_NAME"; then
  echo "Using existing Sprite $SPRITE_NAME"
else
  echo "Creating Sprite $SPRITE_NAME"
  sprite create "$SPRITE_NAME"
fi

sprite use "$SPRITE_NAME"

echo "Uploading gateway and agent files ($(git rev-parse --short HEAD 2>/dev/null || echo unknown))..."
sprite exec -- mkdir -p "$REMOTE_APP" "$REMOTE_AGENT"
sprite exec -- bash -lc "if [ -f $REMOTE_AGENT/.pi/mcp.json ]; then cp $REMOTE_AGENT/.pi/mcp.json /tmp/pi-personal-mcp.json; fi"
sprite exec -- bash -lc "if [ -f /home/sprite/.pi/agent/mcp.json ]; then cp /home/sprite/.pi/agent/mcp.json /tmp/pi-personal-user-mcp.json; fi"
sprite exec -- bash -lc "if [ -d $REMOTE_AGENT/browser-profile ]; then rm -rf /tmp/pi-personal-browser-profile; cp -a $REMOTE_AGENT/browser-profile /tmp/pi-personal-browser-profile; fi"
sprite exec -- bash -lc "if [ -f $REMOTE_AGENT/logins.md ]; then cp -a $REMOTE_AGENT/logins.md /tmp/pi-personal-logins.md; fi"
tar -czf - \
  --exclude .git \
  --exclude node_modules \
  --exclude .env \
  --exclude agent/sessions \
  --exclude agent/state \
  --exclude agent/browser-profile \
  --exclude agent/live-view.md \
  src package.json bun.lock tsconfig.json agent scripts README.md |
  sprite exec -- tar -xzf - -C "$REMOTE_APP"

sprite exec -- bash -lc "rm -rf $REMOTE_AGENT && mkdir -p $REMOTE_AGENT && cp -R $REMOTE_APP/agent/. $REMOTE_AGENT/"
sprite exec -- bash -lc "mkdir -p $REMOTE_AGENT/.pi /home/sprite/.pi/agent
if [ -f /tmp/pi-personal-mcp.json ]; then mv /tmp/pi-personal-mcp.json $REMOTE_AGENT/.pi/mcp.json; fi
if [ -f /tmp/pi-personal-user-mcp.json ]; then mv /tmp/pi-personal-user-mcp.json /home/sprite/.pi/agent/mcp.json; fi
has_mcp() { grep -Eq '\"(url|command)\"' \"\$1\" 2>/dev/null; }
if has_mcp $REMOTE_AGENT/.pi/mcp.json && ! has_mcp /home/sprite/.pi/agent/mcp.json; then cp $REMOTE_AGENT/.pi/mcp.json /home/sprite/.pi/agent/mcp.json; fi
if has_mcp /home/sprite/.pi/agent/mcp.json && ! has_mcp $REMOTE_AGENT/.pi/mcp.json; then cp /home/sprite/.pi/agent/mcp.json $REMOTE_AGENT/.pi/mcp.json; fi
if [ -d /tmp/pi-personal-browser-profile ]; then rm -rf $REMOTE_AGENT/browser-profile; mv /tmp/pi-personal-browser-profile $REMOTE_AGENT/browser-profile; fi
if [ ! -f $REMOTE_AGENT/logins.md ] && [ -f /tmp/pi-personal-logins.md ]; then mv /tmp/pi-personal-logins.md $REMOTE_AGENT/logins.md; fi"
sprite exec -- bash -lc "cat > $REMOTE_APP/.env" < .env
sprite exec -- bash -lc "grep -q AGENT_CWD= $REMOTE_APP/.env || echo AGENT_CWD=$REMOTE_AGENT >> $REMOTE_APP/.env"

echo "Installing gateway packages..."
sprite exec -- bash -lc "cd $REMOTE_APP && bun install"

echo "Installing browser packages if needed..."
sprite exec -- bash "$REMOTE_APP/scripts/install-browser-deps.sh"

echo "Installing Tailscale client if needed..."
sprite exec -- bash "$REMOTE_APP/scripts/install-tailscale.sh"

echo "Installing CC Safety Net into Pi (blocks .env, SSH keys, and extra deny paths)..."
sprite exec -- bash -lc "pi install npm:cc-safety-net"

echo "Making the Sprite URL public so Sendblue can reach it..."
sprite config update --url-auth public

INFO="$(sprite info)"
echo "$INFO"
URL="$(printf '%s\n' "$INFO" | grep -Eo 'https://[^ ]+\.sprites\.app' | head -n 1 || true)"
if [[ -z "$URL" ]]; then
  echo "Could not parse Sprite URL from sprite info. Copy it from the output above." >&2
  exit 1
fi

ORIGIN="${URL%/}"
python3 - "$ROOT/.env" SPRITE_URL "$ORIGIN" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
key, value = sys.argv[2], sys.argv[3]
lines = path.read_text().splitlines() if path.exists() else []
out, found = [], False
for line in lines:
    if line.startswith(f"{key}="):
        out.append(f"{key}={value}")
        found = True
    else:
        out.append(line)
if not found:
    if out and out[-1] != "":
        out.append("")
    out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n")
PY
sprite exec -- bash -lc "cat > $REMOTE_APP/.env" < .env
sprite exec -- bash -lc "grep -q AGENT_CWD= $REMOTE_APP/.env || echo AGENT_CWD=$REMOTE_AGENT >> $REMOTE_APP/.env"

echo "Installing gateway as a Sprite service..."
sprite exec -- bash -lc "sprite-env services get gateway >/dev/null 2>&1 && sprite-env services delete gateway || true"
sprite exec -- sprite-env services create gateway \
  --cmd bun \
  --args src/index.ts \
  --dir "$REMOTE_APP" \
  --http-port 8080

export WEBHOOK_URL="${ORIGIN}/webhooks/sendblue/${WEBHOOK_PATH_SECRET}"
echo
echo "Webhook URL:"
echo "  $WEBHOOK_URL"
if [[ -n "${DASHBOARD_SECRET:-}" ]]; then
  echo "Settings dashboard:"
  echo "  ${ORIGIN}/settings/${DASHBOARD_SECRET}"
  echo "Live view:"
  echo "  ${ORIGIN}/settings/${DASHBOARD_SECRET}/browser"
else
  echo "Settings dashboard: off (set DASHBOARD_SECRET in .env to enable)"
fi
if [[ -n "${HEARTBEAT_SECRET:-}" ]]; then
  echo "Home heartbeat (Mac or Raspberry Pi: ./scripts/install-home.sh):"
  echo "  ${ORIGIN}/heartbeat/${HEARTBEAT_SECRET}"
else
  echo "Home heartbeat: off (set HEARTBEAT_SECRET in .env to enable)"
fi
echo

echo "Enabling Sendblue auto typing (covers Sprite warm/cold wake before our process exists)..."
if curl -sS -X POST "https://api.sendblue.com/accounts/settings/auto-typing-indicator" \
  -H "sb-api-key-id: $SENDBLUE_API_KEY_ID" \
  -H "sb-api-secret-key: $SENDBLUE_API_KEY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"auto_typing_indicator": true}' \
  | python3 -c 'import json,sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if data.get("auto_typing_indicator") is True else 1)'; then
  echo "Sendblue auto typing is on."
else
  echo "Warning: could not enable Sendblue auto typing. Inbound “…” during Sprite wake may be missing." >&2
fi
echo

if [[ "${REGISTER_WEBHOOK:-}" == "1" ]]; then
  echo "Registering Sendblue receive webhook..."
  curl -sS -X POST "https://api.sendblue.com/api/account/webhooks" \
    -H "sb-api-key-id: $SENDBLUE_API_KEY_ID" \
    -H "sb-api-secret-key: $SENDBLUE_API_KEY_SECRET" \
    -H "Content-Type: application/json" \
    -d "$(python3 - <<'PY'
import json, os
print(json.dumps({
  "type": "receive",
  "webhooks": [{
    "url": os.environ["WEBHOOK_URL"],
    "secret": os.environ["SENDBLUE_WEBHOOK_SECRET"],
  }],
}))
PY
)"
  echo
else
  echo "Point Sendblue's receive webhook at that URL with secret SENDBLUE_WEBHOOK_SECRET."
  echo "Or re-run with REGISTER_WEBHOOK=1 ./scripts/provision.sh"
fi

echo
echo "If Pi is not authenticated yet:"
echo "  sprite console -s $SPRITE_NAME"
echo "  pi auth login openrouter --api-key"
echo
echo "Then text $SENDBLUE_FROM_NUMBER from $ALLOWED_PHONE."
echo "Watch logs with: sprite exec -- tail -f /.sprite/logs/services/gateway.log"
