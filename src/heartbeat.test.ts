import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { createDedupe } from "./dedupe";
import {
  HEARTBEAT_OK,
  HEARTBEAT_PROMPT,
  heartbeatPath,
  isSilentHeartbeat,
} from "./heartbeat";
import { liveViewPromptNote } from "./live-view";
import type { PiAgent } from "./pi";
import { createGateway, webhookPath } from "./webhook";

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

async function setup(overrides: Partial<Config> = {}, pi?: Partial<PiAgent>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-heartbeat-"));
  const sent: string[] = [];
  const prompts: string[] = [];
  const holds: string[] = [];
  const gateway = await createGateway({
    config: {
      ...config,
      agentCwd: dir,
      mcpConfigPath: join(dir, ".pi/mcp.json"),
      userMcpPath: join(dir, "missing-user-mcp.json"),
      ...overrides,
    },
    sendblue: {
      async sendTyping() {},
      async sendMessage(_to, content) {
        sent.push(content);
      },
    },
    pi: {
      async prompt(message) {
        prompts.push(message);
        return { kind: "reply", text: HEARTBEAT_OK };
      },
      async restart() {},
      async stop() {},
      ...pi,
    },
    dedupe: await createDedupe(join(dir, "processed.json")),
    browserMcp: false,
    async hold() {
      holds.push("hold");
      return {
        async heartbeat() {},
        async release() {
          holds.push("release");
        },
      };
    },
    typingPulseMs: 0,
  });
  return { gateway, sent, prompts, holds, dir };
}

function beat(path = heartbeatPath(config) ?? "/heartbeat/beat-secret") {
  return new Request(`http://localhost${path}`, { method: "GET" });
}

test("isSilentHeartbeat treats HEARTBEAT_OK as quiet", () => {
  expect(isSilentHeartbeat("HEARTBEAT_OK")).toBe(true);
  expect(isSilentHeartbeat("  heartbeat_ok  ")).toBe(true);
  expect(isSilentHeartbeat("HEARTBEAT_OK\nHEARTBEAT_OK")).toBe(true);
  expect(isSilentHeartbeat("")).toBe(true);
  expect(isSilentHeartbeat("calendar in 10")).toBe(false);
  expect(isSilentHeartbeat("HEARTBEAT_OK trash is out")).toBe(false);
});

test("heartbeat path is off when the secret is missing", () => {
  expect(heartbeatPath({ heartbeatPathSecret: undefined })).toBeUndefined();
  expect(heartbeatPath({ heartbeatPathSecret: "  " })).toBeUndefined();
  expect(heartbeatPath(config)).toBe("/heartbeat/beat-secret");
});

test("unknown heartbeat path is 404", async () => {
  const { gateway, prompts } = await setup();
  const result = await gateway.handle(beat("/heartbeat/nope"));
  expect(result.status).toBe(404);
  expect(result.work).toBeUndefined();
  expect(prompts).toEqual([]);
});

test("disabled heartbeat is 404", async () => {
  const { gateway, prompts } = await setup({ heartbeatPathSecret: undefined });
  const result = await gateway.handle(beat());
  expect(result.status).toBe(404);
  expect(prompts).toEqual([]);
});

test("quiet heartbeat holds the Sprite, prompts Pi, and does not iMessage", async () => {
  const { gateway, sent, prompts, holds } = await setup();
  const result = await gateway.handle(beat());
  expect(result.status).toBe(200);
  expect(result.body).toBe("ok");
  await result.work?.();
  expect(prompts).toEqual([HEARTBEAT_PROMPT]);
  expect(sent).toEqual([]);
  expect(holds).toEqual(["hold", "release"]);
});

test("noisy heartbeat iMessages the allowlisted phone", async () => {
  const { gateway, sent } = await setup({}, {
    async prompt() {
      return { kind: "reply", text: "Package is at the door." };
    },
  });
  const result = await gateway.handle(beat());
  await result.work?.();
  expect(sent).toEqual(["Package is at the door."]);
});

test("heartbeat prefixes the live view URL when known", async () => {
  const liveViewUrl = "https://abc.sprites.app/settings/dash-secret/browser";
  const { gateway, prompts } = await setup({
    dashboardPathSecret: "dash-secret",
    spriteUrl: "https://abc.sprites.app",
  });
  const result = await gateway.handle(beat());
  await result.work?.();
  expect(prompts).toEqual([`${liveViewPromptNote(liveViewUrl)}\n\n${HEARTBEAT_PROMPT}`]);
});

test("heartbeat returns busy when a text is already in flight", async () => {
  let finish: (value: { kind: "reply"; text: string }) => void = () => {};
  const first = new Promise<{ kind: "reply"; text: string }>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const { gateway, sent, prompts } = await setup({}, {
    async prompt(message) {
      prompts.push(message);
      calls += 1;
      if (calls === 1) return first;
      return { kind: "reply", text: "should not run" };
    },
  });
  const text = await gateway.handle(
    new Request(`http://localhost${webhookPath(config)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-signing-secret": config.sendblueWebhookSecret,
      },
      body: JSON.stringify({
        from_number: "+15552222222",
        message_handle: "msg-busy",
        content: "hello",
      }),
    }),
  );
  const textWork = text.work?.();
  const heartbeat = await gateway.handle(beat());
  expect(heartbeat.status).toBe(200);
  expect(heartbeat.body).toBe("busy");
  expect(heartbeat.work).toBeUndefined();
  finish({ kind: "reply", text: "hi" });
  await textWork;
  expect(prompts).toHaveLength(1);
  expect(sent).toEqual(["hi"]);
});

test("install-home.sh is valid bash", () => {
  const script = join(import.meta.dir, "../scripts/install-home.sh");
  const proc = Bun.spawnSync(["bash", "-n", script], { stdout: "pipe", stderr: "pipe" });
  expect(proc.exitCode).toBe(0);
  expect(proc.stderr.toString()).toBe("");
});
