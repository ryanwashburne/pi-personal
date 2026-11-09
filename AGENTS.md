# pi-personal

Personal iMessage agent on a Fly Sprite. You text a Sendblue number; the Sprite wakes; Pi in `agent/` answers; the box sleeps. This is a personal assistant, not a coding harness. The laptop Pi plugin is not used.

This git repo is public. Secrets stay in gitignored files on the Mac and on the Sprite.

`agent/AGENTS.md` is Pi’s workspace map (nested files win for that tree). This file is for coding agents working on the repo.

## Layout

- `src/` — Bun webhook gateway, settings page, live-view Chromium
- `agent/` — copied to `/home/sprite/agent`; Pi’s cwd on the Sprite (`SYSTEM.md`, notes, logins, `imessage.md`, `chrome.md`)
- `agent/imessage.md` — what Messages actually renders in Pi’s reply bubble (markdown does not)
- `agent/chrome.md` — shared Sprite Chromium; live-view URL is generated into gitignored `agent/live-view.md`
- `scripts/provision.sh` — create/update the Sprite and copy `.env` + `agent/logins.md`

## Commands

- Install CLIs: `./scripts/install-clis.sh`
- Tests: `bun test`
- Types: `bun run typecheck`
- Provision (needs local `.env`): `./scripts/provision.sh`

Do not commit unless asked. Do not push unless asked.

## Boundaries

**Always**

- Treat `.env`, `agent/logins.md`, `agent/live-view.md`, `agent/browser-profile/`, and `agent/sessions/` as secret.
- Prefer headings-only checks for `agent/logins.md` (site names exist / fields non-empty). Never print field values.
- Prefer existence-only checks for `agent/live-view.md`. Never print it — the path is `DASHBOARD_SECRET`.
- Run `bun test` after gateway changes.

**Ask first**

- Registering the Sendblue webhook (`REGISTER_WEBHOOK=1`)
- Changing allowlisted phones, dashboard/webhook secrets, or making the Sprite URL public

**Never**

- **Do not read the contents of `agent/logins.md`.** Do not open it in a file-read tool, dump it, grep field values, or paste usernames/passwords into chat, commits, PRs, or README. Existence and `##` headings only.
- **Do not read the contents of `agent/live-view.md`.** It embeds `DASHBOARD_SECRET` in the URL. Existence only.
- Do not read `.env` or print tokens, API keys, phone numbers, or `DASHBOARD_SECRET`.
- Do not commit `.env`, `agent/logins.md`, `agent/live-view.md`, `agent/browser-profile/`, `agent/sessions/`, or `agent/state/`.
- Do not put the owner’s 1Password Personal/Private vault or the 1Password browser extension on the Sprite.
- Do not ask the owner to iMessage a password. Logins happen on the settings-page live view, or Pi fills them with Playwright MCP from `logins.md`.
