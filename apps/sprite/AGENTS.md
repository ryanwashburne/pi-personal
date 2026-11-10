# pi-personal

Personal iMessage agent on a Fly Sprite. You text a Sendblue number; the Sprite wakes; Pi in `agent/` answers; the box sleeps. This is a personal assistant, not a coding harness. The laptop Pi plugin is not used.

This git repo is public. Secrets stay in gitignored files on the Mac and on the Sprite.

`agent/AGENTS.md` is Pi’s workspace map (nested files win for that tree). This file is for coding agents working on the repo.

`PRIVACY.md` is the data-flow map: what Pi sees on the owner’s behalf, which vendors process it, and that Anthropic does not train on commercial API traffic by default. Read it before changing webhooks, sessions, browser, MCP, or logging.

`COST.md` is the spend map: which vendors bill (Sendblue line, Sprite compute, model tokens), published rates, and which actions burn money. Live numbers are the Pi `spend` tool (`agent/.pi/extensions/spend/`). Read both before adding paid APIs, changing the model, or keeping the Sprite awake. Do not invent an invoice.

## Layout

- `src/` — Bun webhook gateway, settings page, live-view Chromium
- `agent/` — copied to `/home/sprite/agent`; Pi’s cwd on the Sprite (`SYSTEM.md`, notes, logins, `imessage.md`, `chrome.md`, `ROUTINES.md`)
- `agent/imessage.md` — what Messages actually renders in Pi’s reply bubble (markdown does not)
- `agent/chrome.md` — shared Sprite Chromium; live-view URL is generated into gitignored `agent/live-view.md`
- `PRIVACY.md` — what data this agent processes and where it goes (LLM, Sendblue, Fly, browser)
- `COST.md` — published rates for Sendblue, Sprite, and model tokens
- `scripts/provision.sh` — create/update the Sprite and copy `.env` + `agent/logins.md`; installs `cc-safety-net` into Pi; enables Sendblue auto-typing (warmup “…”)
- `agent/.cc-safety-net/policy.json` — extra deny paths for Pi (`browser-profile`, sessions, MCP files, gateway `.env`). `logins.md` and `live-view.md` stay readable to Pi
- `agent/.pi/extensions/fetch/` — keyless HTTP `fetch` tool (no search API key)
- `agent/.pi/extensions/spend/` — live spend tool (do not bypass it by reading session JSONL)
- `scripts/install-home.sh` — Mac or Raspberry Pi daemon: Tailscale + `/heartbeat` ping + cron routines. `install` / `update` do not steal the clock; `register` does.
- `scripts/home-daemon.py` — in-process scheduler the installer runs
- `scripts/sync-home.sh` — copy daemon scripts to every `HOME_NODES` box without changing role
- `agent/ROUTINES.md` — how Pi turns plain language into a home-daemon cron
- `scripts/setup-macos-exit-node.sh` / `scripts/setup-rpi-exit-node.sh` — aliases for `install-home.sh`

## Commands

- Install CLIs: `./scripts/install-clis.sh`
- Tests: `bun test`
- Types: `bun run typecheck`
- Provision (needs local `.env`): `./scripts/provision.sh`

Do not commit unless asked. Do not push unless asked.

## Boundaries

**Always**

- Treat `.env`, `agent/logins.md`, `agent/live-view.md`, `agent/.pi/mcp.json`, `agent/browser-profile/`, `agent/sessions/`, `agent/memory/NOTES.md`, `agent/memory/HEARTBEAT-STATE.md`, `agent/memory/routines.json`, `agent/memory/routines/`, `agent/memory/home.json`, and `~/.pi/agent/google-oauth.json` as secret.
- Prefer headings-only checks for `agent/logins.md` (site names exist / fields non-empty). Never print field values.
- Prefer existence-only checks for `agent/live-view.md`. Never print it — the path is `DASHBOARD_SECRET`.
- Prefer existence-only checks for `agent/memory/NOTES.md`, `agent/memory/HEARTBEAT-STATE.md`, `agent/memory/routines.json`, and `agent/memory/home.json` (personal Sprite state). Never print their contents.
- Run `bun test` after gateway changes.
- Keep `logins.md` and `live-view.md` off the CC Safety Net deny list. Pi on the Sprite must read them. Coding agents still must not print their contents.

**Typing (iMessage “…”)**

Warmup dots while Fly starts the Sprite come only from Sendblue auto-typing, enabled in `scripts/provision.sh`. That is an account setting; it takes effect on the next inbound. This process is not running yet (cold) or is frozen (warm). Do not try to cover that window by binding earlier, typing when the webhook lands, pulsing during MCP init, or calling `enableAutoTyping` on boot — those all run after Fly has already forwarded the POST. A GitHub merge does not flip the Sendblue toggle. After a long idle with no outbound, Apple/Sendblue often drop typing even when auto-typing is on (best-effort; they need a recent conversation). Gateway `sendTyping` / pulse is only for after this process is up (Pi thinking).

**Ask first**

- Registering the Sendblue webhook (`REGISTER_WEBHOOK=1`)
- Changing allowlisted phones, dashboard/webhook/heartbeat secrets, or making the Sprite URL public

**Never**

- **Do not read the contents of `agent/logins.md`.** Do not open it in a file-read tool, dump it, grep field values, or paste usernames/passwords into chat, commits, PRs, or README. Existence and `##` headings only.
- **Do not read the contents of `agent/live-view.md`.** It embeds `DASHBOARD_SECRET` in the URL. Existence only.
- Do not read `.env` or print tokens, API keys, phone numbers, `DASHBOARD_SECRET`, or `HEARTBEAT_SECRET`.
- Do not commit `.env`, `agent/logins.md`, `agent/live-view.md`, `agent/.pi/mcp.json`, `agent/browser-profile/`, `agent/sessions/`, `agent/state/`, `agent/memory/NOTES.md`, `agent/memory/HEARTBEAT-STATE.md`, `agent/memory/routines.json`, or `agent/memory/home.json`.
- Do not put the owner’s 1Password Personal/Private vault or the 1Password browser extension on the Sprite.
- Do not ask the owner to iMessage a password. Logins happen on the settings-page live view, or Pi fills them with Playwright MCP from `logins.md`.
