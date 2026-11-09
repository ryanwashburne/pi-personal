import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { createDedupe } from "./dedupe";
import { liveViewFilePath, liveViewPromptNote } from "./live-view";
import type { PiAgent, PromptResult } from "./pi";
import { createGateway, webhookPath } from "./webhook";

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

async function setup(overrides: Partial<Config> = {}, pi?: Partial<PiAgent>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-personal-"));
  const sent: string[] = [];
  const prompts: string[] = [];
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
        return { kind: "reply", text: "got it" };
      },
      async restart() {},
      async stop() {},
      ...pi,
    },
    dedupe: await createDedupe(join(dir, "processed.json")),
    browserMcp: false,
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });
  return { gateway, sent, prompts, dir };
}

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

test("rejects a bad webhook secret", async () => {
  const { gateway } = await setup();
  const result = await gateway.handle(post({ content: "hi" }, { "sb-signing-secret": "nope" }));
  expect(result.status).toBe(401);
  expect(result.work).toBeUndefined();
});

test("drops unknown senders without waking pi", async () => {
  const { gateway, prompts } = await setup();
  const result = await gateway.handle(
    post({
      from_number: "+15559999999",
      message_handle: "1",
      content: "hello",
    }),
  );
  expect(result.status).toBe(200);
  expect(result.work).toBeUndefined();
  expect(prompts).toEqual([]);
});

test("acks then replies to an allowlisted inbound text", async () => {
  const { gateway, sent, prompts } = await setup();
  const result = await gateway.handle(
    post({
      from_number: "+15552222222",
      message_handle: "msg-1",
      content: "what's up",
    }),
  );
  expect(result.status).toBe(200);
  expect(result.body).toBe("ok");
  await result.work?.();
  expect(prompts).toEqual(["what's up"]);
  expect(sent).toEqual(["got it"]);
});

test("prefixes the live view URL when Sprite origin is known", async () => {
  const liveViewUrl = "https://abc.sprites.app/settings/dash-secret/browser";
  const { gateway, prompts, dir } = await setup({
    dashboardPathSecret: "dash-secret",
    spriteUrl: "https://abc.sprites.app",
  });
  const result = await gateway.handle(
    post({
      from_number: "+15552222222",
      message_handle: "msg-live",
      content: "what's up",
    }),
  );
  await result.work?.();
  expect(prompts).toEqual([`${liveViewPromptNote(liveViewUrl)}\n\nwhat's up`]);
  expect(readFileSync(liveViewFilePath(dir), "utf8")).toContain(liveViewUrl);
});

test("learns sprites.app origin from forwarded host", async () => {
  const liveViewUrl = "https://learned.sprites.app/settings/dash-secret/browser";
  const { gateway, prompts } = await setup({ dashboardPathSecret: "dash-secret" });
  const result = await gateway.handle(
    post(
      {
        from_number: "+15552222222",
        message_handle: "msg-host",
        content: "login help",
      },
      { "x-forwarded-host": "learned.sprites.app", "x-forwarded-proto": "https" },
    ),
  );
  await result.work?.();
  expect(prompts).toEqual([`${liveViewPromptNote(liveViewUrl)}\n\nlogin help`]);
});

test("dedupes the same message handle", async () => {
  const { gateway, prompts } = await setup();
  const payload = {
    from_number: "+15552222222",
    message_handle: "msg-dup",
    content: "hello",
  };
  const first = await gateway.handle(post(payload));
  await first.work?.();
  const second = await gateway.handle(post(payload));
  expect(second.body).toBe("duplicate");
  expect(second.work).toBeUndefined();
  expect(prompts).toHaveLength(1);
});

test("does not iMessage a text that was steered into an in-flight turn", async () => {
  let finishFirst: (result: PromptResult) => void = () => {};
  const first = new Promise<PromptResult>((resolve) => {
    finishFirst = resolve;
  });
  let calls = 0;
  const { gateway, sent } = await setup({}, {
    async prompt() {
      calls += 1;
      if (calls === 1) return first;
      return { kind: "injected" };
    },
  });
  const firstReq = await gateway.handle(
    post({ from_number: "+15552222222", message_handle: "msg-a", content: "open gmail" }),
  );
  const firstWork = firstReq.work?.();
  const secondReq = await gateway.handle(
    post({ from_number: "+15552222222", message_handle: "msg-b", content: "use the other tab" }),
  );
  const secondWork = secondReq.work?.();
  finishFirst({ kind: "reply", text: "opened the other tab" });
  await Promise.all([firstWork, secondWork]);
  expect(sent).toEqual(["opened the other tab"]);
});

test("does not iMessage the aborted turn when STOP starts a new one", async () => {
  let finishFirst: (result: PromptResult) => void = () => {};
  const first = new Promise<PromptResult>((resolve) => {
    finishFirst = resolve;
  });
  let calls = 0;
  const { gateway, sent } = await setup({}, {
    async prompt() {
      calls += 1;
      if (calls === 1) return first;
      return { kind: "reply", text: "stopped" };
    },
  });
  const firstReq = await gateway.handle(
    post({ from_number: "+15552222222", message_handle: "msg-a", content: "open gmail" }),
  );
  const firstWork = firstReq.work?.();
  const secondReq = await gateway.handle(
    post({ from_number: "+15552222222", message_handle: "msg-b", content: "STOP" }),
  );
  const secondWork = secondReq.work?.();
  finishFirst({ kind: "injected" });
  await Promise.all([firstWork, secondWork]);
  expect(sent).toEqual(["stopped"]);
});
