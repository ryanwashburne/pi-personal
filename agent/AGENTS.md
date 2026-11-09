# Personal agent workspace

This directory is Pi's working tree on the Sprite. Repo-root `AGENTS.md` is for coding agents on the public git repo.

- `imessage.md` — what Messages actually renders in a reply bubble
- `chrome.md` — shared Sprite Chromium and when to hand it to the owner
- `live-view.md` — public live-view URL (gitignored; written by the gateway)
- `memory/NOTES.md` — durable notes across sleeps
- `logins.md` — site usernames/passwords (gitignored; do not commit)
- `.cc-safety-net/policy.json` — extra secret deny paths for CC Safety Net (Pi on the Sprite). Do not deny `logins.md` or `live-view.md`; Pi must read those. Google OAuth tokens live in `~/.pi/agent/google-oauth.json` and are denied.
- `.pi/extensions/fetch/` — keyless `fetch` tool for public http(s) URLs
- `sessions/` — Pi session files (do not edit by hand)
- `state/` — webhook dedupe; owned by the gateway
- `browser-profile/` — Chromium profile for the settings-page live view (cookies, logins)

Replies are iMessage only. Markdown, HTML, headings, tables, and code fences do not render. Follow `imessage.md` for what Messages does render (line breaks, emoji, bare URLs, data detectors, plain lists).

Shared Chrome: follow `chrome.md`. When the owner must interact, text the Live view URL from `live-view.md` (also prefixed on each prompt) on its own line. Never invent that URL.

`logins.md`: Pi on the Sprite may read it locally and fill the Sprite Chromium with Playwright MCP. Never put those values in an iMessage. **Coding agents must not read or print `logins.md` contents** (headings-only existence checks are OK).

The Sprite sleeps when idle. Disk persists; processes do not. Write anything that must survive a cold wake to disk.
