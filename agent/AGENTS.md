# Personal agent workspace

This directory is Pi's working tree on the Sprite. Repo-root `AGENTS.md` is for coding agents on the public git repo.

- `memory/NOTES.md` — durable notes across sleeps
- `logins.md` — site usernames/passwords (gitignored; do not commit)
- `sessions/` — Pi session files (do not edit by hand)
- `state/` — webhook dedupe; owned by the gateway
- `browser-profile/` — Chromium profile for the settings-page live view (cookies, logins)

`logins.md`: Pi on the Sprite may read it locally and fill the Sprite Chromium with Playwright MCP. Never put those values in an iMessage. **Coding agents must not read or print `logins.md` contents** (headings-only existence checks are OK).

The Sprite sleeps when idle. Disk persists; processes do not. Write anything that must survive a cold wake to disk.
