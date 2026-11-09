import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { dashboardPath } from "./dashboard";
import { createDedupe } from "./dedupe";
import { listMcpServers } from "./mcp-config";
import { createGateway } from "./webhook";

const config: Config = {
  port: 8080,
  webhookPathSecret: "path-secret",
  dashboardPathSecret: "dash-secret",
  sendblueApiKeyId: "id",
  sendblueApiKeySecret: "secret",
  sendblueFromNumber: "+15551111111",
  sendblueWebhookSecret: "hook-secret",
  allowedPhone: "+15552222222",
  piCli: "pi",
  agentCwd: "/tmp",
  sessionDir: "/tmp",
  mcpConfigPath: "/tmp/mcp.json",
  agentTimeoutMs: 1000,
  piProvider: "openrouter",
  piModel: "anthropic/claude-haiku-5.5",
};

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pi-dashboard-"));
  const restarts: number[] = [];
  const gateway = await createGateway({
    config: { ...config, agentCwd: dir, mcpConfigPath: join(dir, "mcp.json") },
    userMcpPath: join(dir, "missing-user-mcp.json"),
    sendblue: {
      async sendTyping() {},
      async sendMessage() {},
    },
    pi: {
      async prompt() {
        return "unused";
      },
      async restart() {
        restarts.push(1);
      },
      async stop() {},
    },
    dedupe: await createDedupe(join(dir, "processed.json")),
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });
  return { gateway, restarts, mcpPath: join(dir, "mcp.json") };
}

function dash(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, init);
}

test("serves HTML at the unguessable settings path", async () => {
  const { gateway } = await setup();
  const path = dashboardPath(config);
  if (!path) throw new Error("dashboard path missing");
  const result = await gateway.handle(dash(path));
  expect(result.status).toBe(200);
  expect(result.headers?.["content-type"]).toContain("text/html");
  expect(result.body).toContain("Add HTTP MCP");
  expect(result.body).toContain("None configured");
});

test("does not serve a dashboard when DASHBOARD_SECRET is unset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-dashboard-off-"));
  const gateway = await createGateway({
    config: {
      ...config,
      dashboardPathSecret: undefined,
      agentCwd: dir,
      mcpConfigPath: join(dir, "mcp.json"),
    },
    sendblue: { async sendTyping() {}, async sendMessage() {} },
    pi: { async prompt() { return ""; }, async restart() {}, async stop() {} },
    userMcpPath: join(dir, "missing-user-mcp.json"),
    dedupe: await createDedupe(join(dir, "processed.json")),
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });
  const result = await gateway.handle(dash("/settings/dash-secret"));
  expect(result.status).toBe(404);
});

test("404s a guessed settings path", async () => {
  const { gateway } = await setup();
  const result = await gateway.handle(dash("/settings/nope"));
  expect(result.status).toBe(404);
});

test("adds an HTTP MCP server from the form and restarts Pi", async () => {
  const { gateway, restarts, mcpPath } = await setup();
  const path = dashboardPath(config);
  if (!path) throw new Error("dashboard path missing");
  const posted = await gateway.handle(
    dash(path, {
      method: "POST",
      body: new URLSearchParams({
        action: "add",
        name: "calendar",
        url: "https://mcp.example.com/mcp",
        token: "tok_123",
      }),
    }),
  );
  expect(posted.status).toBe(303);
  expect(posted.headers?.Location).toContain("notice=");
  expect(restarts).toHaveLength(1);
  expect(await listMcpServers(mcpPath)).toEqual([
    {
      name: "calendar",
      kind: "http",
      target: "https://mcp.example.com/mcp",
      hasAuth: true,
    },
  ]);

  const page = await gateway.handle(dash(path));
  expect(page.body).toContain("https://mcp.example.com/mcp");
  expect(page.body).not.toContain("tok_123");
});

test("removes an MCP server from the form", async () => {
  const { gateway, restarts, mcpPath } = await setup();
  const path = dashboardPath(config);
  if (!path) throw new Error("dashboard path missing");
  await gateway.handle(
    dash(path, {
      method: "POST",
      body: new URLSearchParams({
        action: "add",
        name: "docs",
        url: "https://docs.example.com/mcp",
      }),
    }),
  );
  const removed = await gateway.handle(
    dash(path, {
      method: "POST",
      body: new URLSearchParams({
        action: "remove",
        name: "docs",
      }),
    }),
  );
  expect(removed.status).toBe(303);
  expect(restarts).toHaveLength(2);
  expect(await listMcpServers(mcpPath)).toEqual([]);
});

test("rejects a non-http MCP URL", async () => {
  const { gateway, restarts } = await setup();
  const path = dashboardPath(config);
  if (!path) throw new Error("dashboard path missing");
  const posted = await gateway.handle(
    dash(path, {
      method: "POST",
      body: new URLSearchParams({
        action: "add",
        name: "bad",
        url: "ftp://example.com/mcp",
      }),
    }),
  );
  expect(posted.status).toBe(303);
  expect(posted.headers?.Location).toContain("error=");
  expect(restarts).toHaveLength(0);
});
