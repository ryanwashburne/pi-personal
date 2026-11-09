import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import {
  createFetchHandler,
  startTypingFromRequest,
  webhookPath,
  type EarlyGateway,
} from "./early-typing";

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

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${webhookPath(config)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sb-signing-secret": config.sendblueWebhookSecret,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("listen-path files stay thin so HTTP can bind after this process exists", () => {
  const index = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  const early = readFileSync(join(import.meta.dir, "early-typing.ts"), "utf8");
  for (const src of [index, early]) {
    expect(src).not.toMatch(/from ["']\.\/webhook["']/);
    expect(src).not.toMatch(/from ["']\.\/dashboard["']/);
    expect(src).not.toMatch(/from ["']\.\/google-/);
    expect(src).not.toMatch(/from ["']\.\/playwright-mcp["']/);
    expect(src).not.toMatch(/from ["']\.\/browser-session["']/);
    expect(src).not.toMatch(/from ["']\.\/heartbeat["']/);
    expect(src).not.toMatch(/from ["']\.\/pi["']/);
  }
  expect(early).not.toMatch(/from ["']\.\/app["']/);
  expect(index).not.toMatch(/from ["']\.\/app["']/);
  expect(index).toContain('import("./app")');
  const listenAt = index.indexOf("Bun.serve");
  const loadAppAt = index.indexOf('import("./app")');
  expect(listenAt).toBeGreaterThan(0);
  expect(loadAppAt).toBeGreaterThan(listenAt);
});

test("HTTP handler types after listen, before a hanging app import resolves", async () => {
  const typed: string[] = [];
  let releaseGateway: (gateway: EarlyGateway) => void = () => {};
  const gateway = new Promise<EarlyGateway>((resolve) => {
    releaseGateway = resolve;
  });
  const handleHttp = createFetchHandler({
    config,
    sendblue: {
      async sendTyping(to) {
        typed.push(to);
      },
      async sendMessage() {},
    },
    gateway,
  });

  const webhookP = handleHttp(
    post({ from_number: "+15552222222", message_handle: "wake-cold", content: "hi" }),
  );
  await waitUntil(() => typed.length > 0);
  expect(typed).toEqual(["+15552222222"]);

  releaseGateway({
    async handle() {
      return { status: 200, body: "ok" };
    },
  });
  const response = await webhookP;
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
});

test("startTypingFromRequest types an allowlisted inbound", async () => {
  const typed: string[] = [];
  const started = await startTypingFromRequest(
    post({ from_number: "+15552222222", message_handle: "msg-early", content: "wake up" }),
    config,
    {
      async sendTyping(to) {
        typed.push(to);
      },
      async sendMessage() {},
    },
  );
  expect(started).toBe(true);
  expect(typed).toEqual(["+15552222222"]);
});

async function waitUntil(predicate: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}
