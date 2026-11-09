import type { Config } from "./config";
import { promptWithLiveView, syncLiveViewFile } from "./live-view";
import type { PiAgent } from "./pi";
import type { GatewayResult } from "./result";
import type { SendblueClient } from "./sendblue";
import { splitMessage } from "./split";
import type { Hold } from "./tasks";

export const HEARTBEAT_OK = "HEARTBEAT_OK";

export const HEARTBEAT_PROMPT =
  "This is a scheduled heartbeat, not a text from the owner. Read HEARTBEAT.md and memory/NOTES.md. Do any due checks. If nothing needs the owner's attention, reply with exactly HEARTBEAT_OK and nothing else. If something does, follow imessage.md and send only what they need.";

type HeartbeatConfig = Pick<Config, "heartbeatPathSecret" | "allowedPhone" | "agentCwd" | "dashboardPathSecret" | "spriteUrl">;

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

export function heartbeatPrompt(liveViewUrl: string | undefined): string {
  return promptWithLiveView(HEARTBEAT_PROMPT, liveViewUrl);
}

export type HeartbeatOptions = {
  config: HeartbeatConfig;
  pi: PiAgent;
  sendblue: SendblueClient;
  hold: () => Promise<Hold>;
  isBusy: () => boolean;
  setBusy: (busy: boolean) => void;
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
        const result = await options.pi.prompt(heartbeatPrompt(live.liveViewUrl));
        switch (result.kind) {
          case "injected":
            console.log("heartbeat injected");
            break;
          case "reply": {
            if (isSilentHeartbeat(result.text)) {
              console.log("heartbeat silent");
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
