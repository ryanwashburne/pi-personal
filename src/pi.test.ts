import { chmodSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { Config } from "./config";
import { createPiAgent, PI_RPC_TOOLS } from "./pi";

test("RPC tool allowlist declares MCP, codemode, and tool_search", () => {
  expect(PI_RPC_TOOLS).toContain("mcp__*");
  expect(PI_RPC_TOOLS).toContain("codemode");
  expect(PI_RPC_TOOLS).toContain("tool_search");
  expect(PI_RPC_TOOLS).toContain("read");
  expect(PI_RPC_TOOLS).toContain("bash");
});

test("Pi workspace documents iMessage-safe replies", () => {
  const agentDir = join(import.meta.dir, "../agent");
  const system = readFileSync(join(agentDir, "SYSTEM.md"), "utf8");
  const agents = readFileSync(join(agentDir, "AGENTS.md"), "utf8");
  const imessage = readFileSync(join(agentDir, "imessage.md"), "utf8");

  expect(system).toMatch(/iMessage only/i);
  expect(system).toMatch(/stop or cancel/i);
  expect(system).toContain("imessage.md");
  expect(agents).toContain("imessage.md");
  expect(agents).toMatch(/iMessage only/i);

  expect(imessage).toMatch(/markdown renderer/i);
  expect(imessage).toMatch(/emoji/i);
  expect(imessage).toMatch(/bare URLs/i);
  expect(imessage).toMatch(/data detectors/i);
  expect(imessage).toMatch(/Does not render/i);
});

test("Pi workspace documents shared Chrome and the live view URL", () => {
  const agentDir = join(import.meta.dir, "../agent");
  const system = readFileSync(join(agentDir, "SYSTEM.md"), "utf8");
  const agents = readFileSync(join(agentDir, "AGENTS.md"), "utf8");
  const chrome = readFileSync(join(agentDir, "chrome.md"), "utf8");

  expect(system).toContain("chrome.md");
  expect(system).toContain("live-view.md");
  expect(agents).toContain("chrome.md");
  expect(agents).toContain("live-view.md");
  expect(chrome).toMatch(/live view URL/i);
  expect(chrome).toContain("live-view.md");
});

function rpcLog(dir: string): Array<{ type?: string; message?: string; streamingBehavior?: string }> {
  return readFileSync(join(dir, "fake-pi-rpc.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type?: string; message?: string; streamingBehavior?: string });
}

async function fakePi(delayMs = 250) {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
  const wrapper = join(dir, "pi");
  const rpc = join(import.meta.dir, "fake-pi-rpc.ts");
  await Bun.write(wrapper, `#!/bin/sh\nexec bun ${JSON.stringify(rpc)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  await Bun.write(join(dir, "fake-pi-delay-ms"), String(delayMs));
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
    piCli: wrapper,
    agentCwd: dir,
    sessionDir: join(dir, "sessions"),
    mcpConfigPath: join(dir, ".pi/mcp.json"),
    userMcpPath: join(dir, "user-mcp.json"),
    agentTimeoutMs: 5000,
    piProvider: undefined,
    piModel: undefined,
    tailscaleAuthKey: undefined,
    tailscaleExitNode: undefined,
    tailscaleSocksPort: 1055,
  };
  const agent = createPiAgent(config);
  return { dir, agent };
}

async function waitForRpc(dir: string, type: string) {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    try {
      if (rpcLog(dir).some((entry) => entry.type === type)) return;
    } catch {
      // log not created yet
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${type}`);
}

test("steers a second text into the in-flight turn", async () => {
  const { dir, agent } = await fakePi(300);
  try {
    const first = agent.prompt("open gmail");
    await waitForRpc(dir, "prompt");
    const second = agent.prompt("use the other tab");
    expect(await second).toEqual({ kind: "injected" });
    expect(await first).toEqual({
      kind: "reply",
      text: "done:open gmail steered:use the other tab",
    });
    expect(rpcLog(dir).map((entry) => entry.type)).toEqual([
      "prompt",
      "steer",
      "get_last_assistant_text",
    ]);
  } finally {
    await agent.stop();
  }
});

test("STOP aborts the in-flight turn and starts a new prompt", async () => {
  const { dir, agent } = await fakePi(400);
  try {
    const first = agent.prompt("open gmail");
    await waitForRpc(dir, "prompt");
    const second = agent.prompt("STOP");
    expect(await first).toEqual({ kind: "injected" });
    expect(await second).toEqual({ kind: "reply", text: "done:STOP" });
    expect(rpcLog(dir).map((entry) => entry.type)).toEqual([
      "prompt",
      "abort",
      "get_last_assistant_text",
      "prompt",
      "get_last_assistant_text",
    ]);
  } finally {
    await agent.stop();
  }
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
