# Cost

What this personal iMessage agent pays for, which vendors bill, and which actions burn money.

This is a standing map of **rates**. Live numbers come from the `spend` tool (Pi extension). Call `spend` when the owner asks what this costs. Quote only what the tool returned. Do not invent a current balance from these rates.

Last reviewed: 9 Nov 2026 (America/New_York). Vendor prices change. Live secrets (`.env`, invoices, API keys) are not documented here and must not be opened by coding agents. This file does not read `.env`, so it cannot know which model key is actually configured.

## Who bills

| Vendor | Kind | Published rate | What this app uses |
| --- | --- | --- | --- |
| Sendblue | Fixed, per dedicated iMessage line | **$100 / month** on the AI Agent plan. $0 per message. | The production path: dedicated number, webhooks, inbound-first replies to the allowlisted phone. |
| Fly Sprites | Variable compute + always-on cold disk | CPU **$0.0385 / CPU-hour**. Memory **$0.021875 / GB-hour**. Hot storage **$0.000683 / GB-hour** (~$0.50 / GB-month) while awake. Cold storage **$0.000027 / GB-hour** (~$0.02 / GB-month) for as long as the Sprite exists. | The box Pi runs on. Compute stops when it sleeps. Disk (Tigris) does not. |
| Anthropic API | Variable, per token | Haiku 5.5 **$0.10 / $0.50** per million input/output (prompts ≤100k; **$0.50 / $2.50** above). Sonnet 5.5 **$2 / $10**. Opus 5.5 **$4 / $20**. Fable 5.1 **$10 / $50**. | Intended model path (`pi auth login anthropic --api-key` or `ANTHROPIC_API_KEY`). Every turn sends the full session. |
| OpenRouter (if used) | Variable, per token + credit fee | Provider list price. **5.5%** fee when buying Standard credits (8% Business). | Optional (`OPENROUTER_API_KEY`, `PI_PROVIDER=openrouter`). Two bills: OpenRouter credits and the upstream model. |
| OpenAI API (if used) | Variable, per token | Depends on the model (for example GPT-5 **$1.25 / $10** per million). | Optional (`OPENAI_API_KEY`). Only if Pi is pointed at OpenAI. |
| Google Workspace APIs | Free under daily thresholds | Gmail / Calendar / Drive standard use is **$0**. Billing for over-threshold usage is planned later in 2026 with ≥90 days’ notice. | Local Sprite MCP (`mcp__gmail__*`, `mcp__calendar__*`, `mcp__drive__*`, `mcp__search__*`) after settings-page OAuth. |
| Tailscale | $0 on Personal | Personal plan **free forever** (this app’s home exit node is one user). | Chrome egress only. Not on the Sendblue or webhook path. |
| Pi CLI | $0 | MIT-licensed. No seat price. | Local harness on the Sprite. You pay the model provider, not pi.dev. |
| jsDelivr | $0 | Public CDN. | noVNC viewer JS for the live view. |

Fly invoices under **$5** are waived; Sendblue is a separate bill, so a cheap Sprite month does not cancel the line. Tigris object storage for Sprite disk is billed **on the Fly invoice**, not a second account.

Sources: [Sendblue pricing](https://www.sendblue.com/pricing) · [Fly pricing](https://fly.io/pricing) · [Sprites](https://fly.io/sprites/) · [Anthropic API pricing](https://platform.claude.com/docs/en/about-claude/pricing) · [OpenRouter pricing](https://openrouter.ai/pricing) · [OpenAI pricing](https://developers.openai.com/api/docs/pricing) · [Gmail API quotas](https://developers.google.com/workspace/gmail/api/reference/quota) · [Tailscale pricing](https://tailscale.com/pricing)

## Live `spend` tool

Pi’s `spend` tool (allowlisted in the gateway) is the only supported way to read live usage. It does **not** open `.env` as a file and does **not** return message bodies or full phone numbers.

| Source | What you get | Needs |
| --- | --- | --- |
| `vendor=model` (default includes this) | This iMessage session’s Pi-recorded token $ on the current branch | Session JSONL under `SESSION_DIR` |
| Sendblue | Line count, new-contact caps, published $100/line | Existing `SENDBLUE_*` keys |
| OpenRouter | This key’s usage / remaining limit | `OPENROUTER_API_KEY` |
| Anthropic org | UTC-month `cost_report` for the **whole org** | `ANTHROPIC_ADMIN_API_KEY` (or an unscoped personal key). Workspace keys 403. |
| Fly Sprites | Honest miss | Fly has no public billing API |

Session files stay on the CC Safety Net deny list so Pi cannot `read` transcripts. `spend` parses them itself and returns totals only.

## Sendblue: the big fixed cost

One dedicated line at **$100 / month**. Extra texts, typing indicators, and media do not add a per-message fee on that plan. A second number would be another $100.

This app is inbound-first (the owner texts, Pi replies). That matches the published AI Agent plan, not Enterprise outbound. Do not provision another Sendblue line. Do not treat “send fewer messages” as a way to cut this bill — the line is flat.

## Fly Sprite: awake = billed

A Sprite that exists but does nothing costs nothing **beyond stored data**. Warm and cold (asleep) are not billed for CPU, RAM, or hot storage. Cold storage bills for the bytes on disk all month.

What keeps it awake (and therefore billed):

- The inbound webhook connection while Pi is working (`AGENT_TIMEOUT_MS` caps a turn; default 10 minutes)
- The Tasks API hold the gateway takes during a turn
- An open live-view TCP connection (owner watching Chrome)
- Chromium / Xvfb / a long shell job that keeps writing to a session

What does **not** keep it awake after the reply: cookies in `browser-profile`, notes on disk, Google OAuth tokens. Agent-started Chrome does **not** take the `browser` task hold — after the text, the Sprite can sleep and Chrome dies.

Rough order of magnitude, not an invoice: a couple of minutes at ~0.5 CPU and ~1 GB RAM is well under a cent of compute. A 4-hour “leave Chrome up” session is the Fly example in the ~$0.20 range. Cold disk at ~10 GB is ~$0.20 / month even if the box never wakes.

Do not create extra Sprites. Do not leave the live view open unless the owner needs it. Do not start Chromium “just in case.”

## Model tokens: the per-text variable

Pi is free. The model is not. Each turn POSTs the system prompt, the whole `imessage` session (prior turns + every tool result), and the new text. Bigger history, bigger Playwright snapshots, and bigger `fetch` bodies all become input tokens **on this turn and every later turn** until the session is gone.

| Model (Claude API) | Input / output per million tokens | When to use it |
| --- | --- | --- |
| Haiku 5.5 | $0.10 / $0.50 (≤100k input) | Cheap default. `.env.example` names `anthropic/claude-haiku-5.5`. |
| Sonnet 5.5 | $2 / $10 | Heavier reasoning. ~20× Haiku input. |
| Opus 5.5 | $4 / $20 | Do not switch to this unless the owner asks. |
| Fable 5.1 | $10 / $50 | Do not switch to this unless the owner asks. |

A short Haiku reply on a small session is fractions of a cent. The same work on Sonnet with a long Chrome dump in context is tens of cents, then that dump is paid for again on the next text. Prompt cache hits are cheaper (Haiku 5.5 cache read $0.01 / MTok; Sonnet 5.5 $0.10 / MTok) but a new screenshot or fetch still lands as fresh input.

OpenRouter, if used, charges the upstream list price plus the credit-purchase fee. Do not enable the 1% “use my prompts to improve the product” discount (that is a privacy opt-in, not a real savings). Prefer a direct `ANTHROPIC_API_KEY` over OpenRouter.

## What is cheap on purpose

| Action | Why it’s cheap |
| --- | --- |
| `fetch` for a public http(s) URL | No API key, no Chrome, Sprite work is a short HTTP get |
| Google MCP for mail / calendar / Drive / search | Under daily quotas this is $0, and it avoids Chromium |
| Letting the Sprite sleep | Compute and hot storage drop to zero |
| Another iMessage on the same Sendblue line | Flat $100 / month |
| Tailscale exit node | Personal plan is $0 |
| Raspberry Pi at home | Hardware already bought; not a Sprite or Sendblue bill |

## What is expensive (or can be)

| Action | Why it costs |
| --- | --- |
| Playwright / Sprite Chromium | CPU + RAM while Chrome is up; accessibility trees and screenshots inflate **every later** model call |
| Owner leaving live view open | Open TCP holds the Sprite awake even after Pi finished |
| Long-running jobs | The gateway hold and the process keep compute billing until they end or time out |
| Dumping large files into the session | Paid as input tokens this turn and the next ones |
| Switching `PI_MODEL` to Opus / Fable | Multiplies the per-text bill |
| Extra HTTP MCP servers | Those hosts may bill on their own. Do not add paid APIs unless asked |
| Extra Sprites or Sendblue numbers | Another VM’s disk + compute, or another $100 line |
| Google API usage past daily thresholds | Not billed today; Google has said overage pricing comes later in 2026 |

## How a text spends money

```
Owner iPhone → Sendblue (flat line) → Fly Sprite wakes (CPU/RAM/hot disk)
                                      → Pi (free) → Anthropic / OpenRouter / OpenAI (tokens)
                                      ↘ optional Chrome (more Sprite time + more tokens)
                                      ↘ optional Google MCP (usually $0)
Sprite sleeps → compute stops; cold disk keeps a small Fly charge
```

## Operator checks

- Call `spend` for live numbers. Do not claim a dollar amount unless `spend` (or a vendor dashboard the owner opened) actually returned it.
- Prefer `fetch` and Google MCP over Chrome. Open Chromium when the page needs login, JavaScript, or the owner must see it.
- Do not change the model to a more expensive one, add MCP servers, or create infrastructure unless the owner asks.
- Keep `memory/NOTES.md` short. Session JSONL is billed as context every turn — do not paste secrets or huge dumps into it.
- If a job must run a long time, say that the Sprite stays billed while it runs, write resume state to disk, and prefer finishing over polling.
- Confirm on the Sprite which provider is actually configured (`PI_PROVIDER` / `pi auth`). This file will not open `.env`.
- Re-check Sendblue / Fly / Anthropic pricing pages if you rely on a number in this file.
