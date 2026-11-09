import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { headerValue } from "./secret";

export const LIVE_VIEW_FILE = "live-view.md";

export type LiveViewLinks = {
  origin?: string;
  settingsUrl?: string;
  liveViewUrl?: string;
  markdown: string;
};

export function liveViewFilePath(agentCwd: string): string {
  return join(agentCwd, LIVE_VIEW_FILE);
}

export function normalizeOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function dashboardPublicOrigin(
  config: Pick<Config, "spriteUrl">,
  request: Request,
): string | undefined {
  const fromConfig = normalizeOrigin(config.spriteUrl);
  if (fromConfig) return fromConfig;
  const forwarded = originFromHeaders(request.headers);
  if (forwarded) return forwarded;
  try {
    const origin = new URL(request.url).origin;
    const host = new URL(origin).hostname;
    if (host === "localhost" || host === "127.0.0.1") return origin;
  } catch {
    return undefined;
  }
  return undefined;
}

export function originFromHeaders(headers: Headers): string | undefined {
  const forwarded = headerValue(headers, "x-forwarded-host");
  const host = (forwarded ?? headerValue(headers, "host"))?.split(",")[0]?.trim();
  if (!host) return undefined;
  const proto =
    headerValue(headers, "x-forwarded-proto")?.split(",")[0]?.trim() ||
    (host.endsWith(".sprites.app") ? "https" : undefined);
  if (!proto) return undefined;
  const origin = normalizeOrigin(`${proto}://${host}`);
  if (!origin) return undefined;
  try {
    if (!new URL(origin).hostname.endsWith(".sprites.app")) return undefined;
  } catch {
    return undefined;
  }
  return origin;
}

export function resolveLiveView(
  config: Pick<Config, "dashboardPathSecret" | "spriteUrl">,
  headers?: Headers,
): LiveViewLinks {
  const origin = normalizeOrigin(config.spriteUrl) ?? (headers ? originFromHeaders(headers) : undefined);
  const settingsPath = config.dashboardPathSecret
    ? `/settings/${config.dashboardPathSecret}`
    : undefined;
  const viewerPath = settingsPath ? `${settingsPath}/browser` : undefined;
  const settingsUrl = origin && settingsPath ? `${origin}${settingsPath}` : undefined;
  const liveViewUrl = origin && viewerPath ? `${origin}${viewerPath}` : undefined;
  return {
    origin,
    settingsUrl,
    liveViewUrl,
    markdown: renderLiveViewMarkdown({
      dashboardEnabled: Boolean(config.dashboardPathSecret),
      settingsUrl,
      liveViewUrl,
    }),
  };
}

export function renderLiveViewMarkdown(options: {
  dashboardEnabled: boolean;
  settingsUrl?: string;
  liveViewUrl?: string;
}): string {
  if (!options.dashboardEnabled) {
    return `# Live view

Dashboard is off (no DASHBOARD_SECRET). You cannot send a live-view link. If the owner must interact with Chrome, say so.
`;
  }
  if (!options.liveViewUrl) {
    return `# Live view

Dashboard is on but the public Sprite URL is unknown. Do not invent a URL. Set SPRITE_URL in .env (provision.sh writes it) or wait for a public sprites.app request. Until then, tell the owner you cannot send the live-view link yet.
`;
  }
  const settings = options.settingsUrl
    ? `Settings (MCP servers, Tailscale):\n${options.settingsUrl}\n`
    : "";
  return `# Live view

This file is written by the gateway. Do not commit it.

When the owner must interact with the shared Chrome (MFA, CAPTCHA, paste a password, Start to keep the box awake), text this URL on its own line:

${options.liveViewUrl}

Opening that page wakes the Sprite. If Chrome is stopped, they tap Start there — that holds the box awake. An agent-started browser does not.

${settings}`;
}

export function liveViewPromptNote(liveViewUrl: string): string {
  return `Shared Chrome live view (if the owner must interact, text this URL on its own line):\n${liveViewUrl}`;
}

export function syncLiveViewFile(
  config: Pick<Config, "agentCwd" | "dashboardPathSecret" | "spriteUrl">,
  headers?: Headers,
): LiveViewLinks {
  const links = resolveLiveView(config, headers);
  try {
    mkdirSync(config.agentCwd, { recursive: true });
    writeFileSync(liveViewFilePath(config.agentCwd), links.markdown);
  } catch (error) {
    console.warn("live-view.md write failed", error);
  }
  return links;
}

export function promptWithLiveView(prompt: string, liveViewUrl: string | undefined): string {
  if (!liveViewUrl) return prompt;
  return `${liveViewPromptNote(liveViewUrl)}\n\n${prompt}`;
}
