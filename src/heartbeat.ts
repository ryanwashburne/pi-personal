import type { Config } from "./config";
import { rejectForeignHome } from "./home-registration";
import { promptWithLiveView, syncLiveViewFile } from "./live-view";
import type { PiAgent } from "./pi";
import type { GatewayResult } from "./result";
import { runScheduledTurn } from "./scheduled";
import type { SendblueClient } from "./sendblue";
import type { Hold } from "./tasks";

export const HEARTBEAT_OK = "HEARTBEAT_OK";
export const HEARTBEAT_SESSION_ID = "heartbeat";
export const HEARTBEAT_TIMEZONE = "America/New_York";
export const HEARTBEAT_QUIET_START = "22:00";
export const HEARTBEAT_QUIET_END = "08:00";

export const HEARTBEAT_PROMPT =
  "This is a scheduled heartbeat, not a text from the owner. Follow HEARTBEAT.md. Scan calendar, unread mail, and memory/NOTES.md. Do silent drafts and notes. Do not use Chrome. iMessage only for the high bar in HEARTBEAT.md. If nothing needs the owner now, reply with exactly HEARTBEAT_OK and nothing else.";

export const HEARTBEAT_QUIET_HOURS_NOTE = `Quiet hours are in effect (${HEARTBEAT_QUIET_START}–${HEARTBEAT_QUIET_END} ${HEARTBEAT_TIMEZONE}). The gateway will not iMessage this turn. Do silent work only. Reply HEARTBEAT_OK.`;

type HeartbeatConfig = Pick<
  Config,
  "heartbeatPathSecret" | "allowedPhone" | "agentCwd" | "dashboardPathSecret" | "spriteUrl"
>;

export function heartbeatPath(config: Pick<Config, "heartbeatPathSecret">): string | undefined {
  const secret = config.heartbeatPathSecret?.trim();
  if (!secret) return undefined;
  return `/heartbeat/${secret}`;
}

export function isHeartbeatPath(pathname: string, path: string): boolean {
  return pathname === path;
}

export function isSilentHeartbeat(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return trimmed.replace(new RegExp(HEARTBEAT_OK, "gi"), "").trim().length === 0;
}

function parseClockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function zonedClockMinutes(now: Date, timeZone = HEARTBEAT_TIMEZONE): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

export function isQuietHours(
  now: Date,
  options?: { timeZone?: string; start?: string; end?: string },
): boolean {
  const start = parseClockMinutes(options?.start ?? HEARTBEAT_QUIET_START);
  const end = parseClockMinutes(options?.end ?? HEARTBEAT_QUIET_END);
  if (start === end) return false;
  const current = zonedClockMinutes(now, options?.timeZone ?? HEARTBEAT_TIMEZONE);
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

export function heartbeatPrompt(liveViewUrl: string | undefined, quietHours = false): string {
  const body = quietHours ? `${HEARTBEAT_PROMPT}\n\n${HEARTBEAT_QUIET_HOURS_NOTE}` : HEARTBEAT_PROMPT;
  return promptWithLiveView(body, liveViewUrl);
}

export type HeartbeatOptions = {
  config: HeartbeatConfig;
  pi: PiAgent;
  sendblue: SendblueClient;
  hold: () => Promise<Hold>;
  isBusy: () => boolean;
  setBusy: (busy: boolean) => void;
  now?: () => Date;
};

export async function handleHeartbeat(
  request: Request,
  options: HeartbeatOptions,
): Promise<GatewayResult | undefined> {
  const path = heartbeatPath(options.config);
  if (!path) return undefined;
  const url = new URL(request.url);
  if (!isHeartbeatPath(url.pathname, path)) return undefined;
  if (request.method !== "GET" && request.method !== "POST") {
    return { status: 405, body: "method not allowed" };
  }
  const blocked = await rejectForeignHome(request, options.config.agentCwd);
  if (blocked) return blocked;
  if (options.isBusy()) {
    return { status: 200, body: "busy" };
  }
  options.setBusy(true);
  return {
    status: 200,
    body: "ok",
    work: async () => {
      const live = syncLiveViewFile(options.config, request.headers);
      const quietHours = isQuietHours(options.now?.() ?? new Date());
      await runScheduledTurn({
        label: quietHours ? "heartbeat quiet hours" : "heartbeat",
        prompt: heartbeatPrompt(live.liveViewUrl, quietHours),
        pi: options.pi,
        sendblue: options.sendblue,
        to: options.config.allowedPhone,
        hold: options.hold,
        setBusy: options.setBusy,
        shouldDeliver: (text) => !isSilentHeartbeat(text) && !quietHours,
      });
    },
  };
}
