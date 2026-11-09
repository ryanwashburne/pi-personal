# pi-personal

Personal iMessage agent on a [Fly Sprite](https://fly.io/sprites/). Text a Sendblue number, the Sprite wakes, Pi answers, then the box sleeps so compute drops to zero.

This is a personal assistant, not a coding harness. Pi runs **inside** the Sprite. The laptop plugin is not used.

This repo is meant to be public. Keep secrets in `.env` on your machine and on the Sprite — never in git.

## Flow

1. You iMessage the Sendblue number from your allowlisted phone.
2. Sendblue POSTs to the Sprite URL. That request wakes the VM (about 100–500ms warm, 1–2s cold).
3. The gateway checks the signing secret and phone allowlist, returns 200, then holds the Sprite awake with the Tasks API while Pi runs.
4. Pi's reply goes back out through Sendblue. The hold is released and the Sprite sleeps.

## Setup

```bash
./scripts/install-clis.sh
sprite login
cp .env.example .env
```

Fill `.env` (this file is gitignored):

- Sendblue API key/secret and `SENDBLUE_FROM_NUMBER`
- `ALLOWED_PHONE` — your number, E.164
- `WEBHOOK_PATH_SECRET` and `SENDBLUE_WEBHOOK_SECRET` — long random strings
- `DASHBOARD_SECRET` — long random string for the settings page (optional; omit to disable it)
- a model key (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, …)

```bash
./scripts/provision.sh
```

That creates Sprite `pi-personal`, copies this repo onto it, installs `gateway` as the HTTP service, and prints the public webhook URL and settings page. Re-run with `REGISTER_WEBHOOK=1` to append that URL on your Sendblue account, or paste it in the Sendblue dashboard yourself.

The Sprite already hosts HTTP on port 8080. The settings page is the same public `*.sprites.app` URL, at `/settings/$DASHBOARD_SECRET`. Open it in a browser to add an HTTP MCP server (your URL, optional bearer token) and to start the Sprite Chromium. **Open live view** streams that browser so you can log into sites yourself — never text passwords. Cookies stay in `agent/browser-profile/` across sleeps. Do not share that link; it is the only auth on the page. The webhook path stays separate so Sendblue never sees the dashboard secret.

Pi always reads `~/.pi/agent/mcp.json`. With `--approve` it also reads `.pi/mcp.json` in the agent workspace. The settings page writes **both**, with `exposure: "direct"` so tools are declared to the model as `mcp__<name>__<tool>`. An empty `mcpServers` object means no MCP tools yet — paste a URL on the page, then send a new text. The settings page also runs `pi mcp list` so you can see connect errors instead of an empty tool list.

First-time Pi login on the Sprite:

```bash
sprite console -s pi-personal
pi auth login anthropic --api-key
```

Text the Sendblue number from `ALLOWED_PHONE`. You should get a typing indicator, then a reply. After a few idle minutes the Sprite sleeps; the next text wakes it.

Logs:

```bash
sprite exec -- tail -f /.sprite/logs/services/gateway.log
```

## Local checks

```bash
bun test
```

The gateway can also run on your laptop (`bun start`) with the same `.env` if you point a Sendblue webhook at a tunnel. Without `/.sprite/api.sock` the Tasks API hold is a no-op.

## Layout

- `src/` — webhook gateway (Bun), including the settings live-view browser
- `agent/` — Pi working tree (`SYSTEM.md`, notes). Copied to `/home/sprite/agent` on the Sprite
- `scripts/provision.sh` — create/update the Sprite; installs Google Chrome, Xvfb, and x11vnc if missing (ignores Ubuntu’s snap stub)
- `.env.example` — names of required secrets, no real values

## What must not be committed

- `.env` and any real API keys, phone numbers, or webhook secrets
- `.sprite` (Fly org/sprite selection)
- `agent/sessions/` and `agent/state/` (conversation history)
- `agent/browser-profile/` (Chromium logins and cookies)
- Pi `auth.json` / provider credentials

Access control for the live agent is the unguessable webhook path, the Sendblue signing secret, the phone allowlist in `.env`, and the unguessable settings path (that same path is the only lock on the streamed browser). Sendblue keys stay in the gateway. Pi does not get a “text anyone” tool.
