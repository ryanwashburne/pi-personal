# pi-personal

Personal iMessage agent on a [Fly Sprite](https://fly.io/sprites/). Text a Sendblue number, the Sprite wakes, Pi answers, then the box sleeps so compute drops to zero.

This is a personal assistant, not a coding harness. Pi runs **inside** the Sprite. The laptop plugin is not used.

This repo is meant to be public. Keep secrets in `.env` on your machine and on the Sprite — never in git.

## Flow

1. You iMessage the Sendblue number from your allowlisted phone.
2. Sendblue POSTs to the Sprite URL. That request wakes the VM (about 100–500ms warm, 1–2s cold). Provisioning turns on Sendblue auto-typing so Apple shows “…” as soon as your inbound hits Sendblue — before the Sprite process exists.
3. The gateway binds a tiny HTTP listener first (config + Sendblue only), sends/refreshes typing as soon as the webhook lands, then loads MCP/Google/Playwright and holds the Sprite awake with the open webhook connection (and the Tasks API) while Pi runs.
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
- `HEARTBEAT_SECRET` — long random string for the home-daemon ping (optional; omit to disable it)
- a model key (`OPENROUTER_API_KEY`; this app does not use a direct Anthropic key)
- optional site logins in `agent/logins.md` (gitignored; copy from `agent/logins.md.example`)

```bash
./scripts/provision.sh
```

That creates Sprite `pi-personal`, copies this repo onto it, installs `gateway` as the HTTP service, and prints the public webhook URL and settings page. Re-run with `REGISTER_WEBHOOK=1` to append that URL on your Sendblue account, or paste it in the Sendblue dashboard yourself.

The Sprite already hosts HTTP on port 8080. The settings page is the same public `*.sprites.app` URL, at `/settings/$DASHBOARD_SECRET`. Open it in a browser to connect Gmail/Calendar/Drive/search, add an extra HTTP MCP server (your URL, optional bearer token), and watch Sprite Chromium. Pi starts that Chromium itself when a text needs the web; Playwright MCP then drives it (`mcp__playwright__*`). **Open live view** (`/settings/$DASHBOARD_SECRET/browser`) streams the same window so you can watch or log into sites yourself — never text passwords. ⌘V / Ctrl+V (or the Paste button) types into that Chrome. Cookies stay in `agent/browser-profile/` across sleeps. Do not share that link; it is the only auth on the page. The webhook path stays separate so Sendblue never sees the dashboard secret.

`provision.sh` writes `SPRITE_URL` into `.env`. The gateway copies the live-view URL into gitignored `agent/live-view.md` and prefixes it on each Pi prompt, so when Chrome needs you, Pi can iMessage that link as a bare URL.

To make Sprite Chrome look like your house IP, and to wake the Sprite on a timer for a quiet heartbeat, install the home daemon on the boxes that live on your tailnet. **Only one box is registered** as the clock (heartbeat + crons) and the Chrome exit node.

**First deploy**

```bash
./scripts/provision.sh
./scripts/install-home.sh            # this box: Tailscale + API, standby
./scripts/install-home.sh register   # this box becomes the clock
```

Then in the Tailscale admin console: **Use as exit node** and **Disable key expiry**. Put a reusable, non-ephemeral `TAILSCALE_AUTHKEY` in `.env`. After register, the Sprite stores the hostname in gitignored `agent/memory/home.json`; `TAILSCALE_EXIT_NODE` is only a fallback until that file exists. Re-run `./scripts/provision.sh` so the Sprite has the auth key. List every home hostname in `HOME_NODES` (comma-separated) so later provisions can update them.

**Incremental deploy** (code only — does not change who is registered):

```bash
./scripts/provision.sh
```

That updates the Sprite, then `scripts/sync-home.sh` copies the daemon onto this machine (if `~/.pi-personal-home` exists) and every `HOME_NODES` host. `install-home.sh update` keeps `role`. `REGISTER_WEBHOOK=1` stays opt-in.

If `SPRITE_URL` and `HEARTBEAT_SECRET` are set, the **registered** box pings `/heartbeat/$HEARTBEAT_SECRET` every 2 hours (`HEARTBEAT_INTERVAL_SECONDS`). Each ping is a full Pi turn that can scan mail and calendar; the Sprite still sleeps between pings. Quiet hours (22:00–08:00 America/New_York) still run the turn but do not iMessage. The same daemon stores owner-defined **routines** (plain language → 5-field cron) and POSTs `/routine/$HEARTBEAT_SECRET` when they fire. A Mac LaunchAgent only runs while you are logged in — lid closed, pings stop until you `register` an always-on Raspberry Pi. `standby` demotes this box without uninstalling. `uninstall` stops the daemon (and writes standby so a later install does not steal the clock). If an older install wrote `1800` into `~/.pi-personal-home/env`, set `HEARTBEAT_INTERVAL_SECONDS=7200` and re-run `update`. Existing installs that have an `env` file but no `role` file are grandfathered as the active clock.

The Sprite looks up the registered hostname in `tailscale status --json` and sets the exit node by its `100.x` address (MagicDNS is off so a hostname often fails). Only Chromium uses the SOCKS proxy — Sendblue and the live-view URL stay on Fly. Heartbeat and routine fires from any other node id are rejected with 409 before a Pi turn.

The iMessage agent does **not** run on the home box. Do not install the gateway, Sendblue, or Chrome there. Hardware, forgotten-login recovery, and moving the daemon to a Pi are in [Raspberry Pi (home exit node)](#raspberry-pi-home-exit-node).

Pi always reads `~/.pi/agent/mcp.json`. With `--approve` it also reads `.pi/mcp.json` in the agent workspace. The gateway writes a built-in Playwright stdio server into **both** so Pi can start Chromium and control it over CDP (`127.0.0.1:9222`). Those files are gitignored: Playwright’s command is the host `bun` path, and extra servers may include bearer tokens. After you connect Google on the settings page, it also writes Gmail, Calendar, Drive, and search stdio servers (`mcp__gmail__*`, `mcp__calendar__*`, `mcp__drive__*`, `mcp__search__*`) that call Google’s REST APIs from the Sprite. Tokens stay in `~/.pi/agent/google-oauth.json` on the Sprite. The settings page adds extra HTTP servers the same way, with `exposure: "direct"` so tools are declared to the model as `mcp__<name>__<tool>`. The settings page also runs `pi mcp list` so you can see connect errors instead of an empty tool list. An agent-started browser does not take the Sprite `browser` task hold — after the reply the Sprite can sleep and Chrome dies; cookies stay on disk. Start from settings if you want the box held awake for a live-view login.

### Gmail, Calendar, and Drive MCP

Local stdio MCP on the Sprite talks to Gmail, Calendar, and Drive REST. Search fans out across those three. Mail and files go Sprite ↔ Google only — not through Google’s hosted Workspace MCP or any other proxy. This app does not ship a client secret; you create a Google Cloud OAuth web client and paste its ID/secret into `.env`. Personal Gmail works.

1. In Google Cloud, enable **Gmail API**, **Google Calendar API**, and **Google Drive API**.
2. Configure the OAuth consent screen (External is fine for a personal account; add yourself as a test user). Add the Gmail, Calendar, and Drive scopes listed on the settings page.
3. Create an OAuth client of type **Web application**.
4. Put `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in `.env` and re-run `./scripts/provision.sh`.
5. Open the settings page, copy the **Redirect URI** into that OAuth client's Authorized redirect URIs, then click **Connect Google**.

Gmail MCP can draft and cannot send. Tokens persist in `~/.pi/agent/google-oauth.json` across provision (that path is not under `agent/`).

`provision.sh` also runs `pi install npm:cc-safety-net`. That extension blocks `.env`, SSH keys, and the extra paths in `agent/.cc-safety-net/policy.json` (`browser-profile`, sessions, MCP config, the gateway `.env`, Google OAuth tokens). It does **not** block `logins.md` or `live-view.md` — Pi has to read those. Built-in `fetch` (no API key) loads public http(s) pages without Chrome; Playwright stays for logins and JS. Built-in `spend` reports live usage this agent can measure (this session’s tokens, Sendblue line caps, OpenRouter key usage). Fly has no billing API. The RPC allowlist includes `fetch` and `spend`.

First-time Pi login on the Sprite:

```bash
sprite console -s pi-personal
pi auth login openrouter --api-key
```

Text the Sendblue number from `ALLOWED_PHONE`. You should get a typing indicator on a warm or cold wake, then a reply. After a few idle minutes the Sprite sleeps; the next text wakes it. Re-run `./scripts/provision.sh` after pulling so Sendblue auto-typing is enabled on the account (it takes effect on the next inbound).

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

If you already ran `./scripts/install-home.sh` on the Mac, enroll the Pi as standby then move the clock:

```bash
scp ~/.pi-personal-home/env ~/.pi-personal-home/install-home.sh ~/.pi-personal-home/home-daemon.py USER@raspberrypi.local:
ssh USER@raspberrypi.local
sudo bash install-home.sh
sudo bash install-home.sh register
```

The Mac stays installed so the next `./scripts/provision.sh` can update it; it is demoted to standby. Or copy `scripts/install-home.sh` from this repo and export `SPRITE_URL` / `HEARTBEAT_SECRET` (or put them in `env` next to the script). On Linux it must be `sudo` so the service starts at boot.

The installer installs Tailscale if needed, turns on IP forwarding, enables Tailscale SSH, and starts the daemon. `register` advertises the exit node, tells the Sprite this node is the clock, and demotes other `HOME_NODES`. Then in the admin console: **Use as exit node** and **Disable key expiry**. Keep `TAILSCALE_AUTHKEY`. Optional stable name: `TS_HOSTNAME=rpi-home sudo bash install-home.sh`. Add both hostnames to `HOME_NODES` in `.env`.

## Local checks

```bash
bun test
```

The gateway can also run on your laptop (`bun start`) with the same `.env` if you point a Sendblue webhook at a tunnel. Without `/.sprite/api.sock` the Tasks API hold is a no-op.

## Layout

- `src/` — webhook gateway (Bun), including the settings live-view browser
- `agent/` — Pi working tree (`SYSTEM.md`, notes, `chrome.md`). Copied to `/home/sprite/agent` on the Sprite
- `scripts/provision.sh` — create/update the Sprite; installs Google Chrome, Xvfb, x11vnc, Tailscale if missing, and CC Safety Net into Pi
- `scripts/install-home.sh` — Mac or Raspberry Pi: Tailscale + Sprite heartbeat ping + routines (`install` / `update` / `register` / `standby`)
- `scripts/home-daemon.py` — scheduler the home installer runs (stdlib Python)
- `scripts/sync-home.sh` — provision helper: update every `HOME_NODES` daemon without changing role
- `scripts/setup-macos-exit-node.sh` / `scripts/setup-rpi-exit-node.sh` — aliases for `install-home.sh`
- `AGENTS.md` — instructions for coding agents
- `.env.example` — names of required secrets, no real values

## What must not be committed

- `.env` and any real API keys, phone numbers, or webhook secrets
- `.sprite` (Fly org/sprite selection)
- `agent/sessions/` and `agent/state/` (conversation history)
- `agent/browser-profile/` (Chromium logins and cookies)
- `agent/logins.md` (site usernames and passwords)
- `agent/live-view.md` (public live-view URL; embeds `DASHBOARD_SECRET`)
- `agent/memory/NOTES.md`, `agent/memory/HEARTBEAT-STATE.md`, `agent/memory/routines.json`, and `agent/memory/home.json` (personal Sprite notes / schedules / registered home box)
- Pi `auth.json` / provider credentials
- `~/.pi/agent/google-oauth.json` (Google MCP tokens on the Sprite)

Access control for the live agent is the unguessable webhook path, the Sendblue signing secret, the phone allowlist in `.env`, the unguessable settings path (that same path is the only lock on the streamed browser), and the unguessable heartbeat/routine/home-register path the home daemon curls. Sendblue keys stay in the gateway. Pi does not get a “text anyone” tool. The home daemon API is Tailscale-only and uses the same `HEARTBEAT_SECRET`. Only the registered node id may run heartbeat or routines.
