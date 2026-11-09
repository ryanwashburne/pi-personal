import type { Config } from "./config";
import { promptWithLiveView, syncLiveViewFile } from "./live-view";
import type { PiAgent } from "./pi";
import type { GatewayResult } from "./result";
import type { SendblueClient } from "./sendblue";
import { splitMessage } from "./split";
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

export function handleHeartbeat(request: Request, options: HeartbeatOptions): GatewayResult | undefined {
  const path = heartbeatPath(options.config);
  if (!path) return undefined;
  const url = new URL(request.url);
  if (!isHeartbeatPath(url.pathname, path)) return undefined;
  if (request.method !== "GET" && request.method !== "POST") {
    return { status: 405, body: "method not allowed" };
  }
  if (options.isBusy()) {
    return { status: 200, body: "busy" };
  }
  options.setBusy(true);
  return {
    status: 200,
    body: "ok",
    work: async () => {
      const taskP = options.hold().catch((error) => {
        console.warn("heartbeat task hold failed", error);
        return { async heartbeat() {}, async release() {} };
      });
      try {
        const live = syncLiveViewFile(options.config, request.headers);
        const quietHours = isQuietHours(options.now?.() ?? new Date());
        const result = await options.pi.prompt(heartbeatPrompt(live.liveViewUrl, quietHours));
        switch (result.kind) {
          case "injected":
            console.log("heartbeat injected");
            break;
          case "reply": {
            if (isSilentHeartbeat(result.text) || quietHours) {
              console.log(quietHours ? "heartbeat quiet hours" : "heartbeat silent");
              break;
            }
            console.log(`heartbeat reply (${result.text.length} chars)`);
            for (const chunk of splitMessage(result.text)) {
              await options.sendblue.sendMessage(options.config.allowedPhone, chunk);
            }
            break;
          }
          default: {
            const _never: never = result;
            throw new Error(`unexpected heartbeat result ${JSON.stringify(_never)}`);
          }
        }
      } catch (error) {
        console.error("heartbeat turn failed", error);
      } finally {
        options.setBusy(false);
        const task = await taskP;
        await task.release().catch((releaseError) => console.warn("heartbeat task release failed", releaseError));
      }
    },
  };
}
