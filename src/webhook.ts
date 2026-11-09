import { join } from "node:path";
import { normalizePhone, type Config } from "./config";
import { handleDashboard } from "./dashboard";
import { createDedupe, type Dedupe } from "./dedupe";
import { syncMcpConfigFiles } from "./mcp-config";
import { promptFromInbound, parseInbound } from "./inbound";
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

type GatewayOptions = {
  config: Config;
  sendblue: SendblueClient;
  pi: PiAgent;
  dedupe?: Dedupe;
  hold?: () => Promise<Hold>;
  userMcpPath?: string;
};

export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  const dedupe =
    options.dedupe ?? (await createDedupe(join(options.config.agentCwd, "state", "processed.json")));
  await syncMcpConfigFiles(
    options.config.mcpConfigPath,
    options.userMcpPath ?? options.config.userMcpPath,
  ).catch((error) => {
    console.warn("mcp config migrate failed", error);
  });
  const inFlight = new Set<string>();
  const hold = options.hold ?? holdSprite;

  return {
    async handle(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return { status: 200, body: "ok" };
      }
      const dashboard = await handleDashboard(request, {
        config: options.config,
        pi: options.pi,
      });
      if (dashboard) return dashboard;
      if (request.method !== "POST" || url.pathname !== webhookPath(options.config)) {
        return { status: 404, body: "not found" };
      }

      const provided =
        headerValue(request.headers, "sb-signing-secret") ??
        headerValue(request.headers, "x-sb-signing-secret") ??
        headerValue(request.headers, "x-webhook-secret");
      if (!secretsEqual(provided, options.config.sendblueWebhookSecret)) {
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

      return {
        status: 200,
        body: "ok",
        work: async () => {
          console.log(`work ${inbound.messageHandle} from ${from}: ${inbound.content.slice(0, 80)}`);
          const taskP = hold().catch((error) => {
            console.warn("task hold failed", error);
            return { async heartbeat() {}, async release() {} };
          });
          try {
            void options.sendblue.sendTyping(from).catch((error) => {
              console.warn("typing failed", error);
            });
            console.log(`prompt ${inbound.messageHandle}`);
            const reply = await options.pi.prompt(promptFromInbound(inbound));
            console.log(`reply ${inbound.messageHandle} (${reply.length} chars)`);
            const chunks = splitMessage(reply);
            for (const chunk of chunks) {
              await options.sendblue.sendMessage(from, chunk);
            }
            await dedupe.remember(inbound.messageHandle);
          } catch (error) {
            console.error("agent turn failed", error);
            await options.sendblue
              .sendMessage(from, "I hit an error working on that. Try me again in a minute.")
              .catch((sendError) => console.error("error reply failed", sendError));
          } finally {
            inFlight.delete(inbound.messageHandle);
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
