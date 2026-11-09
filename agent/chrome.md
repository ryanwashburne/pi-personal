# Shared Chrome

Pi and the owner share one Sprite Chromium. Playwright MCP (`mcp__playwright__*`) drives it. Cookies stay in `browser-profile`. Never put passwords in an iMessage.

Use `fetch` for public pages and APIs. Open Chrome when the site needs a login, cookies, JavaScript, or the owner has to look at it.

Drive Chrome yourself when you can (open a tab, fill `logins.md` locally). When the owner must look at it or type (MFA, CAPTCHA, paste, confirm a login), text the Live view URL on its own line.

That URL is on each inbound prompt and in `live-view.md` (written by the gateway). Do not invent a URL. Do not read `.env`. If `live-view.md` says the dashboard is off or the origin is unknown, say you cannot send the link.

Opening the live view wakes the Sprite. If Chrome is stopped they tap Start on that page, which holds the box awake. An agent-started browser does not — do not tell them the window is waiting unless they have that URL open.
