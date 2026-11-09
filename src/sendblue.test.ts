import { expect, test } from "bun:test";
import type { Config } from "./config";
import { createSendblueClient, TYPING_MAX_DURATION_MS, type SendblueFetch } from "./sendblue";

const config: Config = {
  port: 8080,
  webhookPathSecret: "path-secret",
  dashboardPathSecret: undefined,
  spriteUrl: undefined,
  sendblueApiKeyId: "id",
  sendblueApiKeySecret: "secret",
  sendblueFromNumber: "+15551111111",
  sendblueWebhookSecret: "hook-secret",
  allowedPhone: "+15552222222",
  piCli: "pi",
  agentCwd: "/tmp",
  sessionDir: "/tmp",
  mcpConfigPath: "/tmp/mcp.json",
  userMcpPath: "/tmp/user-mcp.json",
  agentTimeoutMs: 1000,
  piProvider: undefined,
  piModel: undefined,
  tailscaleAuthKey: undefined,
  tailscaleExitNode: undefined,
  tailscaleSocksPort: 1055,
};

type Call = { url: string; body: Record<string, unknown> };

function jsonResponse(status: number, body: unknown = { status: "QUEUED" }): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recordFetch(handler: (call: Call, n: number) => Response | Error): { fetchFn: SendblueFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: SendblueFetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    calls.push(call);
    const result = handler(call, calls.length);
    if (result instanceof Error) throw result;
    return result;
  };
  return { fetchFn, calls };
}

test("sendTyping asks Sendblue to hold “…” for the max duration", async () => {
  const { fetchFn, calls } = recordFetch(() => jsonResponse(200));
  const client = createSendblueClient(config, fetchFn);
  await client.sendTyping("+15552222222");
  expect(calls).toEqual([
    {
      url: "https://api.sendblue.com/api/send-typing-indicator",
      body: {
        number: "+15552222222",
        from_number: "+15551111111",
        state: "start",
        max_duration_ms: TYPING_MAX_DURATION_MS,
      },
    },
  ]);
});

test("sendTyping retries a cold-start network failure", async () => {
  const { fetchFn, calls } = recordFetch((_call, n) => (n === 1 ? new Error("timeout") : jsonResponse(200)));
  const client = createSendblueClient(config, fetchFn);
  await client.sendTyping("+15552222222");
  expect(calls).toHaveLength(2);
});

test("sendTyping falls back to legacy start when firmware rejects typing-v2", async () => {
  const { fetchFn, calls } = recordFetch((_call, n) =>
    n === 1 ? jsonResponse(503, { status: "ERROR" }) : jsonResponse(200),
  );
  const client = createSendblueClient(config, fetchFn);
  await client.sendTyping("+15552222222");
  expect(calls).toHaveLength(2);
  expect(calls[1]?.body).toEqual({
    number: "+15552222222",
    from_number: "+15551111111",
  });
});

test("enableAutoTyping turns on Sendblue's inbound typing indicator", async () => {
  const { fetchFn, calls } = recordFetch(() => jsonResponse(200, { status: "OK", auto_typing_indicator: true }));
  const client = createSendblueClient(config, fetchFn);
  await client.enableAutoTyping?.();
  expect(calls).toEqual([
    {
      url: "https://api.sendblue.com/accounts/settings/auto-typing-indicator",
      body: { auto_typing_indicator: true },
    },
  ]);
});
