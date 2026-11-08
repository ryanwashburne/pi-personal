# Personal agent workspace

This directory is Pi's working tree on the Sprite.

- `memory/NOTES.md` — durable notes across sleeps
- `sessions/` — Pi session files (do not edit by hand)
- `state/` — webhook dedupe; owned by the gateway

The Sprite sleeps when idle. Disk persists; processes do not. Write anything that must survive a cold wake to disk.
