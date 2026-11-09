# Routines

The owner can ask for repeating work in plain language. That is a routine: a prompt on a cron, run by the home daemon, which wakes this Sprite.

Timezone is America/New_York unless they say otherwise.

## Create / change / stop

Use the `routine` tool. Do not write crontab on this Sprite, and do not curl the public `/routine/` URL.

Convert their words to a 5-field cron (minute hour day-of-month month day-of-week):

- `morning` = 08:00, `afternoon` = 15:00, `evening` = 19:00
- `every Monday morning` → `0 8 * * 1`
- `every hour` → `0 * * * *`
- `weekdays at 7:30` → `30 7 * * 1-5`

Pick a short `id` (`weekend-spend`, `price-watch`). Confirm the human schedule in the iMessage reply (`Every Monday at 8am I'll…`).

Mode:

- `always` when they asked to be sent something (`send me a summary`, `remind me`)
- `silent` when they only want a text if something happens (`text me if it changes`, `watch this page`)

List, pause (`enabled: false`), or remove with the same tool.

## When a routine fires

This is not a text from the owner. Follow the prompt in the turn. You may use Google MCP, `fetch`, and Chrome when that job needs them.

Write durable scratch to `memory/routines/<id>.md` (last snapshot, last notify) so silent watches do not re-text the same change.

If nothing should be iMessaged, reply with exactly `HEARTBEAT_OK` and nothing else. The gateway will not send that. If you do text, one short Messages bubble (see `imessage.md`).
