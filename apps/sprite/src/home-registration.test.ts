import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDedupe } from "./dedupe";
import type { Config } from "./config";
import { HEARTBEAT_OK } from "./heartbeat";
import {
  HOME_NODE_HEADER,
  UNREGISTERED_HOME_BODY,
  effectiveExitNode,
  handleHomeRegister,
  homePath,
  loadHomeRegistration,
  registeredHostname,
  saveHomeRegistration,
} from "./home-registration";
import { createGateway, webhookPath } from "./webhook";
import type { PiAgent } from "./pi";

const config: Config = {
  port: 8080,
  webhookPathSecret: "path-secret",
  dashboardPathSecret: undefined,
  heartbeatPathSecret: "beat-secret",
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

async function setup(dir?: string) {
  const agentCwd = dir ?? (await mkdtemp(join(tmpdir(), "pi-home-reg-")));
  const prompts: string[] = [];
  const defaultPi: PiAgent = {
    async prompt(message) {
      prompts.push(message);
      return { kind: "reply", text: HEARTBEAT_OK };
    },
    async restart() {},
    async stop() {},
  };
  const gateway = await createGateway({
    config: {
      ...config,
      agentCwd,
      mcpConfigPath: join(agentCwd, ".pi/mcp.json"),
      userMcpPath: join(agentCwd, "missing-user-mcp.json"),
    },
    sendblue: {
      async sendTyping() {},
      async sendMessage() {},
    },
    pi: defaultPi,
    heartbeatPi: defaultPi,
    routinesPi: defaultPi,
    dedupe: await createDedupe(join(agentCwd, "processed.json")),
    browserMcp: false,
    typingPulseMs: 0,
  });
  return { gateway, prompts, agentCwd };
}

test("home path follows the heartbeat secret", () => {
  expect(homePath({ heartbeatPathSecret: undefined })).toBeUndefined();
  expect(homePath(config)).toBe("/home/beat-secret");
});

test("effectiveExitNode prefers home.json over env fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-home-exit-"));
  expect(effectiveExitNode(dir, "env-node")).toBe("env-node");
  expect(registeredHostname(dir)).toBeUndefined();
  await saveHomeRegistration(dir, {
    nodeId: "nABCDEF",
    hostname: "rpi-home",
    registeredAt: "2026-11-09T12:00:00.000Z",
  });
  expect(registeredHostname(dir)).toBe("rpi-home");
  expect(effectiveExitNode(dir, "env-node")).toBe("rpi-home");
});

test("POST /home writes memory/home.json", async () => {
  const { gateway, agentCwd } = await setup();
  const result = await gateway.handle(
    new Request(`http://localhost${homePath(config)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "nABCDEF", hostname: "rpi-home" }),
    }),
  );
  expect(result.status).toBe(200);
  const stored = await loadHomeRegistration(agentCwd);
  expect(stored?.nodeId).toBe("nABCDEF");
  expect(stored?.hostname).toBe("rpi-home");
  expect(result.work).toBeUndefined();
});

test("POST /home rejects a bad body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-home-bad-"));
  const result = await handleHomeRegister(
    new Request("http://localhost/home/beat-secret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "nope" }),
    }),
    { config: { ...config, agentCwd: dir } },
  );
  expect(result?.status).toBe(400);
  expect(await loadHomeRegistration(dir)).toBeUndefined();
});

test("heartbeat from an unknown node is 409 before Pi", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-home-409-"));
  await saveHomeRegistration(dir, {
    nodeId: "nABCDEF",
    hostname: "rpi-home",
    registeredAt: "2026-11-09T12:00:00.000Z",
  });
  const { gateway, prompts } = await setup(dir);
  const result = await gateway.handle(new Request("http://localhost/heartbeat/beat-secret"));
  expect(result.status).toBe(409);
  expect(result.body).toBe(UNREGISTERED_HOME_BODY);
  expect(result.work).toBeUndefined();
  expect(prompts).toEqual([]);
});

test("heartbeat from the registered node is allowed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-home-ok-"));
  await saveHomeRegistration(dir, {
    nodeId: "nABCDEF",
    hostname: "rpi-home",
    registeredAt: "2026-11-09T12:00:00.000Z",
  });
  const { gateway, prompts } = await setup(dir);
  const result = await gateway.handle(
    new Request("http://localhost/heartbeat/beat-secret", {
      headers: { [HOME_NODE_HEADER]: "nABCDEF" },
    }),
  );
  expect(result.status).toBe(200);
  await result.work?.();
  expect(prompts.length).toBeGreaterThan(0);
});

test("routine fire from an unknown node is 409 before Pi", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-home-r409-"));
  await saveHomeRegistration(dir, {
    nodeId: "nABCDEF",
    hostname: "rpi-home",
    registeredAt: "2026-11-09T12:00:00.000Z",
  });
  const { gateway, prompts } = await setup(dir);
  const result = await gateway.handle(
    new Request("http://localhost/routine/beat-secret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "weekend-spend", prompt: "summarize", mode: "always" }),
    }),
  );
  expect(result.status).toBe(409);
  expect(result.body).toBe(UNREGISTERED_HOME_BODY);
  expect(result.work).toBeUndefined();
  expect(prompts).toEqual([]);
});

test("unregistered Sprite still accepts heartbeat (bootstrap)", async () => {
  const { gateway, prompts } = await setup();
  const result = await gateway.handle(new Request("http://localhost/heartbeat/beat-secret"));
  expect(result.status).toBe(200);
  await result.work?.();
  expect(prompts.length).toBeGreaterThan(0);
});

test("unknown home path is 404, not a register", async () => {
  const { gateway } = await setup();
  const result = await gateway.handle(
    new Request("http://localhost/home/nope", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "nABCDEF", hostname: "rpi-home" }),
    }),
  );
  expect(result.status).toBe(404);
});

test("inbound text is not blocked by home.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-home-text-"));
  await saveHomeRegistration(dir, {
    nodeId: "nABCDEF",
    hostname: "rpi-home",
    registeredAt: "2026-11-09T12:00:00.000Z",
  });
  const { gateway, prompts } = await setup(dir);
  const result = await gateway.handle(
    new Request(`http://localhost${webhookPath(config)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-signing-secret": config.sendblueWebhookSecret,
      },
      body: JSON.stringify({
        from_number: "+15552222222",
        message_handle: "msg-home",
        content: "hello",
      }),
    }),
  );
  expect(result.status).toBe(200);
  await result.work?.();
  expect(prompts.length).toBeGreaterThan(0);
});
