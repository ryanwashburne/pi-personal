# pi-personal

Personal iMessage agent on a [Fly Sprite](https://fly.io/sprites/). Text a Sendblue number, the Sprite wakes, Pi answers, then the box sleeps so compute drops to zero.

This is a personal assistant, not a coding harness. Pi runs **inside** the Sprite. The laptop plugin is not used.

This repo is meant to be public. Keep secrets in `.env` on your machine and on the Sprite — never in git.

## Flow

1. You iMessage the Sendblue number from your allowlisted phone.
2. Sendblue POSTs to the Sprite URL. That request wakes the VM (about 100–500ms warm, 1–2s cold).
3. The gateway checks the signing secret and phone allowlist, returns 200, then holds the Sprite awake with the Tasks API while Pi runs.
4. Another text while Pi is working steers the current turn after the in-flight tool call. `STOP` / `cancel` aborts it. Pi's reply goes back out through Sendblue. The hold is released and the Sprite sleeps.

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
- optional site logins in `agent/logins.md` (gitignored; copy from `agent/logins.md.example`)

```bash
./scripts/provision.sh
```

That creates Sprite `pi-personal`, copies this repo onto it, installs `gateway` as the HTTP service, and prints the public webhook URL and settings page. Re-run with `REGISTER_WEBHOOK=1` to append that URL on your Sendblue account, or paste it in the Sendblue dashboard yourself.

The Sprite already hosts HTTP on port 8080. The settings page is the same public `*.sprites.app` URL, at `/settings/$DASHBOARD_SECRET`. Open it in a browser to connect Gmail/Calendar/Drive/search, add an extra HTTP MCP server (your URL, optional bearer token), and watch Sprite Chromium. Pi starts that Chromium itself when a text needs the web; Playwright MCP then drives it (`mcp__playwright__*`). **Open live view** (`/settings/$DASHBOARD_SECRET/browser`) streams the same window so you can watch or log into sites yourself — never text passwords. ⌘V / Ctrl+V (or the Paste button) types into that Chrome. Cookies stay in `agent/browser-profile/` across sleeps. Do not share that link; it is the only auth on the page. The webhook path stays separate so Sendblue never sees the dashboard secret.

`provision.sh` writes `SPRITE_URL` into `.env`. The gateway copies the live-view URL into gitignored `agent/live-view.md` and prefixes it on each Pi prompt, so when Chrome needs you, Pi can iMessage that link as a bare URL.

To make Sprite Chrome look like your house IP, run a Tailscale **exit node** at home. The MacBook works for a first test; the Raspberry Pi is the always-on box.

```bash
./scripts/setup-macos-exit-node.sh   # Mac, for a first test
./scripts/setup-rpi-exit-node.sh     # on the Pi, when you want it always on
```

Each script advertises that machine as an exit node and prints the `TAILSCALE_EXIT_NODE` value (hostname is fine). Put a reusable, non-ephemeral `TAILSCALE_AUTHKEY` in `.env` once — that key is for the Sprite, not the Pi. Re-run `./scripts/provision.sh`. The Sprite looks up that name in `tailscale status --json` and sets the exit node by its `100.x` address (MagicDNS is off so a hostname often fails). Only Chromium uses the SOCKS proxy — Sendblue and the live-view URL stay on Fly. The exit node must stay on while Chrome needs the home IP.

The iMessage agent does **not** run on the Raspberry Pi. Do not install the gateway, Sendblue, or Chrome there. Hardware, forgotten-login recovery, and the on-device script are in [Raspberry Pi (home exit node)](#raspberry-pi-home-exit-node).

Pi always reads `~/.pi/agent/mcp.json`. With `--approve` it also reads `.pi/mcp.json` in the agent workspace. The gateway writes a built-in Playwright stdio server into **both** so Pi can start Chromium and control it over CDP (`127.0.0.1:9222`). After you connect Google on the settings page, it also writes Gmail, Calendar, Drive, and search stdio servers (`mcp__gmail__*`, `mcp__calendar__*`, `mcp__drive__*`, `mcp__search__*`) that call Google’s REST APIs from the Sprite. Tokens stay in `~/.pi/agent/google-oauth.json` on the Sprite. The settings page adds extra HTTP servers the same way, with `exposure: "direct"` so tools are declared to the model as `mcp__<name>__<tool>`. The settings page also runs `pi mcp list` so you can see connect errors instead of an empty tool list. An agent-started browser does not take the Sprite `browser` task hold — after the reply the Sprite can sleep and Chrome dies; cookies stay on disk. Start from settings if you want the box held awake for a live-view login.

### Gmail, Calendar, and Drive MCP

Local stdio MCP on the Sprite talks to Gmail, Calendar, and Drive REST. Search fans out across those three. Mail and files go Sprite ↔ Google only — not through Google’s hosted Workspace MCP or any other proxy. This app does not ship a client secret; you create a Google Cloud OAuth web client and paste its ID/secret into `.env`. Personal Gmail works.

1. In Google Cloud, enable **Gmail API**, **Google Calendar API**, and **Google Drive API**.
2. Configure the OAuth consent screen (External is fine for a personal account; add yourself as a test user). Add the Gmail, Calendar, and Drive scopes listed on the settings page.
3. Create an OAuth client of type **Web application**.
4. Put `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in `.env` and re-run `./scripts/provision.sh`.
5. Open the settings page, copy the **Redirect URI** into that OAuth client's Authorized redirect URIs, then click **Connect Google**.

Gmail MCP can draft and cannot send. Tokens persist in `~/.pi/agent/google-oauth.json` across provision (that path is not under `agent/`).

`provision.sh` also runs `pi install npm:cc-safety-net`. That extension blocks `.env`, SSH keys, and the extra paths in `agent/.cc-safety-net/policy.json` (`browser-profile`, sessions, MCP config, the gateway `.env`, Google OAuth tokens). It does **not** block `logins.md` or `live-view.md` — Pi has to read those. Built-in `fetch` (no API key) loads public http(s) pages without Chrome; Playwright stays for logins and JS. The RPC allowlist in the gateway includes `fetch`.

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

## Raspberry Pi (home exit node)

You only need a Linux box that stays powered on house internet and advertises a Tailscale exit node. Ethernet is more reliable than Wi-Fi.

**Hardware to gather** (model is printed on the board):

- The Pi itself (3 / 4 / 5 is plenty; a Zero W works but prefer ethernet)
- Matching power supply: Pi 5 USB-C 5V/5A, Pi 4 USB-C 5V/3A, Pi 3 / Zero micro-USB 5V/~2.5A
- The microSD already in it, or a fresh 16GB+ card
- Ethernet cable (preferred) or the home Wi-Fi SSID and password
- If you cannot SSH in: HDMI (micro-HDMI on Pi 4/5, full-size on Pi 3) plus a USB keyboard

**If you forgot the old setup**, try in this order before flashing:

1. [Tailscale machines](https://login.tailscale.com/admin/machines) — it may still be on the tailnet
2. Router DHCP list, then `ping raspberrypi.local`
3. Old Raspberry Pi OS default was `pi` / `raspberry`; newer images have no default password (whatever you set in Imager)

Locked out or dead card: [Raspberry Pi Imager](https://www.raspberrypi.com/software/) → Raspberry Pi OS Lite, enable SSH, set a user, prefill Wi-Fi if you have no ethernet, flash, boot, then:

```bash
scp scripts/setup-rpi-exit-node.sh USER@raspberrypi.local:
ssh USER@raspberrypi.local
sudo bash setup-rpi-exit-node.sh
```

The script installs Tailscale if needed, turns on IP forwarding, advertises an exit node, and enables Tailscale SSH. Then in the admin console: **Use as exit node** and **Disable key expiry**. Set `TAILSCALE_EXIT_NODE` to the hostname it prints, keep `TAILSCALE_AUTHKEY`, provision again. Optional stable name: `TS_HOSTNAME=rpi-home sudo bash setup-rpi-exit-node.sh`.

## Local checks

```bash
bun test
```

The gateway can also run on your laptop (`bun start`) with the same `.env` if you point a Sendblue webhook at a tunnel. Without `/.sprite/api.sock` the Tasks API hold is a no-op.

## Layout

- `src/` — webhook gateway (Bun), including the settings live-view browser
- `agent/` — Pi working tree (`SYSTEM.md`, notes, `chrome.md`). Copied to `/home/sprite/agent` on the Sprite
- `scripts/provision.sh` — create/update the Sprite; installs Google Chrome, Xvfb, x11vnc, Tailscale if missing, and CC Safety Net into Pi
- `scripts/setup-macos-exit-node.sh` — run on the MacBook to advertise a Tailscale exit node
- `scripts/setup-rpi-exit-node.sh` — run on the Raspberry Pi to advertise the always-on exit node
- `AGENTS.md` — instructions for coding agents
- `.env.example` — names of required secrets, no real values

## What must not be committed

- `.env` and any real API keys, phone numbers, or webhook secrets
- `.sprite` (Fly org/sprite selection)
- `agent/sessions/` and `agent/state/` (conversation history)
- `agent/browser-profile/` (Chromium logins and cookies)
- `agent/logins.md` (site usernames and passwords)
- `agent/live-view.md` (public live-view URL; embeds `DASHBOARD_SECRET`)
- Pi `auth.json` / provider credentials
- `~/.pi/agent/google-oauth.json` (Google MCP tokens on the Sprite)

Access control for the live agent is the unguessable webhook path, the Sendblue signing secret, the phone allowlist in `.env`, and the unguessable settings path (that same path is the only lock on the streamed browser). Sendblue keys stay in the gateway. Pi does not get a “text anyone” tool.
