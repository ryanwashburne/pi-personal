# Privacy

What this personal iMessage agent sees on the owner’s behalf, where that data goes, and whether model providers train on it.

This is a single-owner assistant, not a product that processes other people’s accounts. “On behalf of the user” means: whatever the owner texts, plus whatever Pi can reach with its tools on the Sprite.

Last reviewed: 9 Nov 2026 (America/New_York). Vendor policies change — re-check Anthropic / OpenRouter account settings if you rely on “no training.” Live secrets (`.env`, `agent/logins.md`, `agent/live-view.md`) are not documented here and must not be opened by coding agents.

## Anthropic: is data passed, and do they train on it?

Yes, prompts go to OpenRouter, which forwards Claude models to Anthropic. No: the commercial Claude API does not use those inputs or outputs to train models unless you opt in (thumbs-up feedback, Development Partner Program).

Pi is a local CLI on the Sprite. It is not the model. On each turn it POSTs the conversation to whichever provider is configured (`PI_PROVIDER` / `PI_MODEL`, or Pi’s default after `pi auth login`). The intended setup is `PI_PROVIDER=openrouter` plus `OPENROUTER_API_KEY` (or `pi auth login openrouter --api-key`). Confirm that on the Sprite — this file does not read `.env`.

| Question | API key / OpenRouter → Anthropic | Claude.ai consumer login |
| --- | --- | --- |
| Is the data sent to Anthropic? | Yes. Full prompts, history, tool calls, and tool results. | Yes, to Anthropic’s consumer product. |
| Used to train Claude? | No, by default. Opt-in only. | Your choice in Claude data-privacy controls. On = used to improve models, kept up to 5 years. |
| How long do they keep it? | Deleted from backend within ~30 days. Flagged abuse: up to 2 years. Covered models require 30-day retention. | 30 days if training is off; 5 years if training is on. |
| Zero data retention? | Not on by default. Sales-enablement for qualifying orgs; some frontier models are not ZDR-eligible. | Not offered on Free/Pro/Max. |

What “sent to Anthropic” includes is not just the iMessage. Pi rebuilds the session and sends the system prompt, prior turns, and every tool result. If Pi reads email, a bank page, or `logins.md` to fill a form, that content is in the model request. Playwright returns accessibility snapshots of the live page (`fill()` arguments, including passwords, go to the model even though they must not be iMessaged). The live-view URL, which embeds `DASHBOARD_SECRET`, is prefixed onto every prompt.

Sources: [Is my data used for model training?](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training) · [Commercial retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) · [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) · [Claude Code data usage](https://code.claude.com/docs/en/data-usage)

## How a text is processed

```
Owner iPhone → Apple iMessage → Sendblue Mac + API → Fly Sprite gateway → Pi (local tools) → OpenRouter → upstream model
Home daemon (Mac/rpi) → HTTPS /heartbeat or POST /routine → Fly Sprite gateway ↗
                                                                                 ↘ Sprite Chromium → Tailscale exit node → websites
```

The reply walks the message path back. Browser traffic is a side path. Sprite disk syncs to Tigris.

## Data the agent sees

| Data class | Collected from | Used for | Leaves the Sprite? |
| --- | --- | --- | --- |
| iMessage body | Sendblue inbound webhook (`content`) | The user prompt for Pi | Yes — Sendblue, Fly logs (first 80 chars), Pi session, LLM |
| Phone numbers | Webhook `from_number`; `ALLOWED_PHONE`; Sendblue from-number | Allowlist; typing indicator; reply routing; settings page display | Yes — Sendblue, settings HTML, gateway logs |
| Attachments | Sendblue `media_url` (CDN link; gateway does not download) | Appended to the prompt as a URL. Pi may fetch it. | URL always to the LLM. Bytes only if Pi fetches them. |
| Conversation history | Pi JSONL under `agent/sessions/` (`imessage` for texts; `heartbeat` for the stay-ahead loop; `routines` for cron jobs) | Every later turn’s context in that session | Yes — full history to the LLM each turn; disk replica on Tigris |
| System + skill files | `SYSTEM.md`, `imessage.md`, `chrome.md`, `live-view.md`, `memory/NOTES.md`, `PRIVACY.md`, `COST.md` | Standing instructions and durable memory | Yes — included in model context when Pi loads them |
| Site logins | gitignored `logins.md` (url / username / password / notes) | Pi fills Sprite Chrome via Playwright. Must not be texted. | To the LLM if Pi reads the file or passes values as tool args |
| Browser cookies / logged-in sites | `agent/browser-profile/` Chromium profile | Stay signed in across Sprite sleeps | Page snapshots and fetched content go to the LLM. Cookies stay on disk unless a site or Chrome syncs them. |
| Live Chrome session | Playwright MCP accessibility tree; optional screenshots; VNC live view | Act on the web; owner can watch or type (including paste) | Snapshots/screenshots → LLM. VNC pixels → whoever has the settings URL. noVNC JS loaded from jsDelivr. |
| Shell / files on the Sprite | Pi tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `codemode`, MCP | Do the task | Tool outputs in the session and in the next LLM call |
| Extra MCP servers | HTTP servers added on the settings page (optional bearer token) | Whatever that server exposes | Tool results → LLM. Token stored on Sprite only. The MCP host sees the calls. |
| Heartbeat mail / calendar scan | Google MCP on the scheduled home-daemon ping | Stay-ahead drafts and rare iMessage alerts | Yes — subjects/events to the LLM in the `heartbeat` session. Gmail drafts stay in Gmail. |
| Routines | Owner iMessage → `routine` tool → home-daemon cron → POST `/routine/$HEARTBEAT_SECRET` | Repeating prompts (summaries, watches) | Yes — the routine prompt and tool results go to the LLM in the `routines` session. The cron and prompt also live in `~/.pi-personal-home/routines.json` on the home box. |
| Home IP / browsing destinations | Tailscale exit node (Mac or Raspberry Pi) for Chrome only | Make Sprite Chrome look like house internet | Websites see the home IP. Tailscale does not read payload. Sendblue stays on Fly. |

## Who processes it

| Party | Sees message content? | Trains on it? | Notes |
| --- | --- | --- | --- |
| Apple (iMessage) | Not as a server. Sendblue’s Mac is the other E2E endpoint, so that device has plaintext. | No | SMS fallback would be carrier-visible. This app prefers iMessage. |
| Sendblue | Yes | No indication of ML training; they store and deliver. | Physical Mac minis. HIPAA isolation is a separate product/BAA. [Privacy](https://www.sendblue.com/privacy-policy) · [Security](https://docs.sendblue.com/security/) |
| Fly / Tigris | Yes, on disk and in logs (partial) | No (your app data). Fly uses other AI vendors on their own platform logs. | Public webhook URL. Settings URL is the only lock on live Chrome. [Privacy](https://fly.io/legal/privacy-policy/) · [Sub-processors](https://fly.io/legal/sub-processors/) · [Sprite disk](https://docs.fly.io/sprites/concepts/lifecycle) |
| Pi CLI (pi.dev) | Yes, locally. Install telemetry is version-only; off with `PI_TELEMETRY=0`. | No | Sessions stay on disk unless you `/share` or `/bug` a transcript. [Sessions](https://pi.dev/docs/latest/sessions) · [Telemetry](https://pi.dev/docs/latest/environment-variables) |
| OpenRouter | Yes, in transit | No by default | This app’s model path. Do not enable prompt logging or the 1% product-improvement toggle. [Data collection](https://openrouter.ai/docs/guides/privacy/data-collection) · [Provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging) |
| Anthropic (upstream via OpenRouter) | Yes, when `PI_MODEL` is `anthropic/…` | No by default | 30-day safety retention on the far side. Not a direct Anthropic key. |
| OpenAI API (if used) | Yes | No by default | 30-day abuse logs. [Your data](https://developers.openai.com/api/docs/guides/your-data) |
| Tailscale | No (cannot decrypt) | No | Chrome only. Metadata, not page content. Exit-node destinations not logged by default. [Privacy](https://tailscale.com/legal/privacy-policy) |
| Websites Pi opens | Yes — logged-in browser from the home IP (or Fly IP if no exit node) | Per site | Cookies persist in `browser-profile`. |
| jsDelivr (noVNC script) | No message content. The owner’s browser fetches the viewer JS. | No | VNC pixels go Sprite ↔ browser, not through jsDelivr. |
| Google Chrome | Local profile; may contact Google for updates / Safe Browsing unless disabled | N/A | Dedicated `user-data-dir`. Owner can also sign into a Google account in that profile. |

`.env.example` is OpenRouter (`OPENROUTER_API_KEY`, `PI_PROVIDER=openrouter`). Two companies see Claude prompts: OpenRouter in transit, Anthropic as upstream. Anthropic’s 30-day / no-training API policy still applies on the far side.

## What stays on the Sprite

Disk survives sleep; processes do not. These paths are gitignored.

| Store | Contents | Risk if the Sprite or Tigris copy leaks |
| --- | --- | --- |
| `.env` | Sendblue keys, phone, webhook/dashboard secrets, model keys, Tailscale auth key | Full takeover of the agent and number |
| `agent/sessions/` | Entire iMessage↔Pi transcript including tool output | Full history of everything Pi saw |
| `agent/logins.md` | Site usernames and passwords | Account takeover of those sites |
| `agent/browser-profile/` | Chromium cookies, local storage, saved passwords | Session hijack for logged-in sites |
| `agent/live-view.md` | Public live-view URL with `DASHBOARD_SECRET` | Remote control of Sprite Chrome |
| `agent/state/processed.json` | Sendblue `message_handle` ids (no bodies) | Low |
| `~/.pi/agent/auth.json`, `~/.pi/agent/mcp.json`, and `agent/.pi/mcp.json` | Provider credentials; MCP URLs, host-specific Playwright paths, and bearer tokens | Model-account and MCP-server access |
| `agent/memory/NOTES.md` | Durable notes Pi is told to keep | Whatever was written there |
| `agent/memory/routines.json` | Scheduled prompts and cron | The owner’s repeating jobs |
| Fly `gateway.log` | First 80 chars of each inbound text, phone, handles | Message snippets + identity |

## Controls already in the repo

- Unguessable webhook path + Sendblue signing secret + single allowlisted phone.
- Settings/live view is a second unguessable path (that secret is the only auth on VNC; x11vnc itself is `-nopw` but localhost-only).
- Pi has no “text anyone” tool — replies only go to `ALLOWED_PHONE`.
- Public git repo. Secrets are gitignored. Coding agents must not read `logins.md`, `live-view.md`, or `.env`.
- Pi must never iMessage passwords and must not install 1Password on the Sprite.
- MCP tokens are redacted in the settings-page `pi mcp list` dump.

## Operator checks

- Confirm API-key auth (not a Claude.ai consumer session). Avoid thumbs-up feedback on API playground chats.
- Assume the model sees whatever Pi reads. Prefer live-view paste for highly sensitive logins. Keep `NOTES.md` boring.
- Treat the live-view link as shared with the model provider. Rotate `DASHBOARD_SECRET` if a session leaks.
- Don’t put secrets in the first 80 characters of a text (gateway logs that prefix).
- Don’t share the settings link. Rotate `DASHBOARD_SECRET`. Consider disabling the dashboard when idle.
- Stay on OpenRouter. Leave OpenRouter logging and training toggles off; pin `anthropic/…` models rather than auto-routing to providers that may train.
- Accept 30-day provider retention, or request ZDR (paid/sales, and not available for some models).
- Only add MCP hosts you trust. Bearer tokens never go to git; results still go to the LLM.
