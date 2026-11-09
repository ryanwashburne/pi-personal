import { normalizePhone, type Config } from "./config";
import { parseInbound } from "./inbound";
import type { GatewayResult } from "./result";
import { headerValue, secretsEqual } from "./secret";
import type { SendblueClient } from "./sendblue";

/**
 * HTTP surface that can handle a webhook after the heavy gateway modules load.
 * Structural so this file never imports `webhook.ts` (dashboard, MCP, Google).
 */
export type EarlyGateway = {
  handle: (request: Request) => Promise<GatewayResult>;
};

export function webhookPath(config: Pick<Config, "webhookPathSecret">): string {
  return `/webhooks/sendblue/${config.webhookPathSecret}`;
}

export function webhookSecretOk(request: Request, secret: string): boolean {
  const provided =
    headerValue(request.headers, "sb-signing-secret") ??
    headerValue(request.headers, "x-sb-signing-secret") ??
    headerValue(request.headers, "x-webhook-secret");
  return secretsEqual(provided, secret);
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

/**
 * Bind-time HTTP handler: /health and webhook typing work before `gateway` resolves.
 */
export function createFetchHandler(options: {
  config: Config;
  sendblue: SendblueClient;
  gateway: Promise<EarlyGateway>;
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
