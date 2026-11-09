# Personal agent workspace

This directory is Pi's working tree on the Sprite. Repo-root `AGENTS.md` is for coding agents on the public git repo.

- `imessage.md` — what Messages actually renders in a reply bubble
- `memory/NOTES.md` — durable notes across sleeps
- `logins.md` — site usernames/passwords (gitignored; do not commit)
- `sessions/` — Pi session files (do not edit by hand)
- `state/` — webhook dedupe; owned by the gateway
- `browser-profile/` — Chromium profile for the settings-page live view (cookies, logins)

Replies are iMessage only. Markdown, HTML, headings, tables, and code fences do not render. Follow `imessage.md` for what Messages does render (line breaks, emoji, bare URLs, data detectors, plain lists).

`logins.md`: Pi on the Sprite may read it locally and fill the Sprite Chromium with Playwright MCP. Never put those values in an iMessage. **Coding agents must not read or print `logins.md` contents** (headings-only existence checks are OK).

The Sprite sleeps when idle. Disk persists; processes do not. Write anything that must survive a cold wake to disk.
