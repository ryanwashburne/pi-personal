import { join } from "node:path";
import type { BrowserSession } from "./browser-session";
import type { TailscaleService } from "./tailscale";
import { normalizePhone, type Config } from "./config";
import { handleDashboard } from "./dashboard";
import { createDedupe, type Dedupe } from "./dedupe";
import { syncGoogleWorkspaceMcp } from "./google-mcp";
import {
  BROWSER_MCP_NAME,
  mcpConfigPaths,
  syncMcpConfigFiles,
  upsertStdioMcpServers,
} from "./mcp-config";
import { defaultPlaywrightMcp } from "./playwright-mcp";
import { handleHeartbeat } from "./heartbeat";
import { promptFromInbound, parseInbound } from "./inbound";
import { promptWithLiveView, syncLiveViewFile } from "./live-view";
import type { PiAgent } from "./pi";
import type { GatewayResult } from "./result";
import { headerValue, secretsEqual } from "./secret";
import type { SendblueClient } from "./sendblue";
import { splitMessage } from "./split";
import { holdSprite, type Hold } from "./tasks";

export type WebhookResult = GatewayResult;

export type Gateway = {
  handle: (request: Request) => Promise<GatewayResult>;
};

/** Refresh iMessage “…” before Sendblue’s default 60s typing window expires. */
export const TYPING_PULSE_MS = 45_000;

type GatewayOptions = {
  config: Config;
  sendblue: SendblueClient;
  pi: PiAgent;
  browser?: BrowserSession;
  tailscale?: TailscaleService;
  dedupe?: Dedupe;
  hold?: () => Promise<Hold>;
  userMcpPath?: string;
  browserMcp?: { command: string; args: string[] } | false;
  typingPulseMs?: number;
};

export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  const dedupe =
    options.dedupe ?? (await createDedupe(join(options.config.agentCwd, "state", "processed.json")));
  const userMcpPath = options.userMcpPath ?? options.config.userMcpPath;
  await syncMcpConfigFiles(options.config.mcpConfigPath, userMcpPath).catch((error) => {
    console.warn("mcp config migrate failed", error);
  });
  if (options.browserMcp !== false) {
    const spec = options.browserMcp ?? defaultPlaywrightMcp();
    await upsertStdioMcpServers(mcpConfigPaths(options.config.mcpConfigPath, userMcpPath), {
      name: BROWSER_MCP_NAME,
      command: spec.command,
      args: spec.args,
    }).catch((error) => {
      console.warn("playwright mcp config failed", error);
    });
  }
  await syncGoogleWorkspaceMcp(options.config, mcpConfigPaths(options.config.mcpConfigPath, userMcpPath)).catch(
    (error) => {
      console.warn("google mcp config failed", error);
    },
  );
  const inFlight = new Set<string>();
  const hold = options.hold ?? holdSprite;
  const typingPulseMs = options.typingPulseMs ?? TYPING_PULSE_MS;
  let piBusy = false;
  syncLiveViewFile(options.config);

  return {
    async handle(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return { status: 200, body: "ok" };
      }
      const dashboard = await handleDashboard(request, {
        config: options.config,
        pi: options.pi,
        browser: options.browser,
        tailscale: options.tailscale,
      });
      if (dashboard) return dashboard;
      const heartbeat = handleHeartbeat(request, {
        config: options.config,
        pi: options.pi,
        sendblue: options.sendblue,
        hold,
        isBusy: () => piBusy,
        setBusy: (busy) => {
          piBusy = busy;
        },
      });
      if (heartbeat) return heartbeat;
      if (request.method !== "POST" || url.pathname !== webhookPath(options.config)) {
        return { status: 404, body: "not found" };
      }

      if (!webhookSecretOk(request, options.config.sendblueWebhookSecret)) {
        const headerNames = [...request.headers.keys()].join(",");
        console.warn(`unauthorized webhook; headers=${headerNames || "(none)"}`);
        return { status: 401, body: "unauthorized" };
      }

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return { status: 400, body: "invalid json" };
      }

      const inbound = parseInbound(payload);
      if (!inbound) {
        return { status: 200, body: "ignored" };
      }

      const from = normalizePhone(inbound.fromNumber);
      if (from !== options.config.allowedPhone) {
        console.warn(`dropping message from ${inbound.fromNumber}`);
        return { status: 200, body: "ignored" };
      }

      if (dedupe.seen(inbound.messageHandle) || inFlight.has(inbound.messageHandle)) {
        return { status: 200, body: "duplicate" };
      }
      inFlight.add(inbound.messageHandle);
      piBusy = true;
      startTyping(options.sendblue, from);

      return {
        status: 200,
        body: "ok",
        work: async () => {
          console.log(`work ${inbound.messageHandle} from ${from}: ${inbound.content.slice(0, 80)}`);
          const taskP = hold().catch((error) => {
            console.warn("task hold failed", error);
            return { async heartbeat() {}, async release() {} };
          });
          const pulse =
            typingPulseMs > 0
              ? setInterval(() => startTyping(options.sendblue, from), typingPulseMs)
              : undefined;
          try {
            console.log(`prompt ${inbound.messageHandle}`);
            const live = syncLiveViewFile(options.config, request.headers);
            const result = await options.pi.prompt(
              promptWithLiveView(promptFromInbound(inbound), live.liveViewUrl),
            );
            switch (result.kind) {
              case "injected":
                console.log(`injected ${inbound.messageHandle}`);
                break;
              case "reply": {
                console.log(`reply ${inbound.messageHandle} (${result.text.length} chars)`);
                for (const chunk of splitMessage(result.text)) {
                  await options.sendblue.sendMessage(from, chunk);
                }
                break;
              }
              default: {
                const _never: never = result;
                throw new Error(`unexpected prompt result ${JSON.stringify(_never)}`);
              }
            }
            await dedupe.remember(inbound.messageHandle);
          } catch (error) {
            console.error("agent turn failed", error);
            await options.sendblue
              .sendMessage(from, "I hit an error working on that. Try me again in a minute.")
              .catch((sendError) => console.error("error reply failed", sendError));
          } finally {
            if (pulse) clearInterval(pulse);
            inFlight.delete(inbound.messageHandle);
            piBusy = false;
            const task = await taskP;
            await task.release().catch((error) => console.warn("task release failed", error));
          }
        },
      };
    },
  };
}

export function webhookPath(config: Pick<Config, "webhookPathSecret">): string {
  return `/webhooks/sendblue/${config.webhookPathSecret}`;
}

/**
 * Fire iMessage “…” as soon as a waking webhook lands, without waiting for
 * gateway init (MCP sync, Google, Playwright). Safe to call on a cloned Request.
 */
export async function startTypingFromRequest(
  request: Request,
  config: Config,
  sendblue: SendblueClient,
): Promise<boolean> {
  if (request.method !== "POST") return false;
  if (new URL(request.url).pathname !== webhookPath(config)) return false;
  if (!webhookSecretOk(request, config.sendblueWebhookSecret)) return false;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return false;
  }

  const inbound = parseInbound(payload);
  if (!inbound) return false;
  const from = normalizePhone(inbound.fromNumber);
  if (from !== config.allowedPhone) return false;
  await sendblue.sendTyping(from);
  return true;
}

export function createFetchHandler(options: {
  config: Config;
  sendblue: SendblueClient;
  gateway: Promise<Gateway>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    if (request.method === "POST" && url.pathname === webhookPath(options.config)) {
      void startTypingFromRequest(request.clone(), options.config, options.sendblue).catch((error) => {
        console.warn("early typing failed", error);
      });
    }

    const gateway = await options.gateway;
    const result = await gateway.handle(request);
    const summary = result.headers?.["content-type"]?.includes("text/html")
      ? `html ${result.body.length}b`
      : result.body;
    console.log(`${request.method} ${url.pathname} -> ${result.status} ${summary}`);
    // Await the turn while the webhook connection is still open. That HTTP
    // activity is what keeps a Sprite from sleeping; a background promise does not.
    if (result.work) {
      try {
        await result.work();
      } catch (error) {
        console.error("agent work failed", error);
      }
    }
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
}

function webhookSecretOk(request: Request, secret: string): boolean {
  const provided =
    headerValue(request.headers, "sb-signing-secret") ??
    headerValue(request.headers, "x-sb-signing-secret") ??
    headerValue(request.headers, "x-webhook-secret");
  return secretsEqual(provided, secret);
}

function startTyping(sendblue: SendblueClient, to: string): void {
  void sendblue.sendTyping(to).catch((error) => {
    console.warn("typing failed", error);
  });
}
