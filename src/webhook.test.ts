import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { createDedupe } from "./dedupe";
import { liveViewFilePath, liveViewPromptNote } from "./live-view";
import type { PiAgent, PromptResult } from "./pi";
import {
  createFetchHandler,
  createGateway,
  startTypingFromRequest,
  webhookPath,
  type Gateway,
} from "./webhook";

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

async function setup(overrides: Partial<Config> = {}, pi?: Partial<PiAgent>, extra?: { typingPulseMs?: number }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-personal-"));
  const sent: string[] = [];
  const typed: string[] = [];
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
      async sendTyping(to) {
        typed.push(to);
      },
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
    typingPulseMs: extra?.typingPulseMs ?? 0,
  });
  return { gateway, sent, typed, prompts, dir };
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

test("starts typing once an allowlisted inbound is accepted (after this process is up)", async () => {
  const { gateway, typed, prompts } = await setup();
  const result = await gateway.handle(
    post({
      from_number: "+15552222222",
      message_handle: "msg-type",
      content: "hello",
    }),
  );
  expect(typed).toEqual(["+15552222222"]);
  expect(prompts).toEqual([]);
  expect(result.work).toBeDefined();
});

test("refreshes typing while Pi is working, not during Fly warmup", async () => {
  const { gateway, typed } = await setup(
    {},
    {
      async prompt() {
        await Bun.sleep(50);
        return { kind: "reply", text: "done" };
      },
    },
    { typingPulseMs: 15 },
  );
  const result = await gateway.handle(
    post({
      from_number: "+15552222222",
      message_handle: "msg-pulse",
      content: "hello",
    }),
  );
  await result.work?.();
  expect(typed.length).toBeGreaterThan(1);
  expect(typed.every((to) => to === "+15552222222")).toBe(true);
});

test("startTypingFromRequest types a valid inbound and leaves the original body readable", async () => {
  const typed: string[] = [];
  const request = post({
    from_number: "+15552222222",
    message_handle: "msg-early",
    content: "wake up",
  });
  const started = await startTypingFromRequest(request.clone(), config, {
    async sendTyping(to) {
      typed.push(to);
    },
    async sendMessage() {},
  });
  expect(started).toBe(true);
  expect(typed).toEqual(["+15552222222"]);

  const { gateway, prompts } = await setup();
  const result = await gateway.handle(request);
  await result.work?.();
  expect(prompts).toEqual(["wake up"]);
});

test("startTypingFromRequest ignores a bad secret or unknown sender", async () => {
  const typed: string[] = [];
  const sendblue = {
    async sendTyping(to: string) {
      typed.push(to);
    },
    async sendMessage() {},
  };
  expect(
    await startTypingFromRequest(
      post(
        { from_number: "+15552222222", message_handle: "x", content: "hi" },
        { "sb-signing-secret": "nope" },
      ),
      config,
      sendblue,
    ),
  ).toBe(false);
  expect(
    await startTypingFromRequest(
      post({ from_number: "+15559999999", message_handle: "x", content: "hi" }),
      config,
      sendblue,
    ),
  ).toBe(false);
  expect(typed).toEqual([]);
});

test("HTTP handler types before a slow gateway is ready and keeps the webhook open during work", async () => {
  const typed: string[] = [];
  let releaseGateway: (gateway: Gateway) => void = () => {};
  const gateway = new Promise<Gateway>((resolve) => {
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

  const health = await handleHttp(new Request("http://localhost/health"));
  expect(health.status).toBe(200);
  expect(await health.text()).toBe("ok");

  const webhookP = handleHttp(
    post({ from_number: "+15552222222", message_handle: "wake-1", content: "hi" }),
  );
  await waitUntil(() => typed.length > 0);
  expect(typed).toEqual(["+15552222222"]);

  let workStarted = false;
  let finishWork = () => {};
  releaseGateway({
    async handle() {
      return {
        status: 200,
        body: "ok",
        work: async () => {
          workStarted = true;
          await new Promise<void>((resolve) => {
            finishWork = resolve;
          });
        },
      };
    },
  });
  await waitUntil(() => workStarted);

  let webhookDone = false;
  void webhookP.then(() => {
    webhookDone = true;
  });
  await Bun.sleep(20);
  expect(webhookDone).toBe(false);

  finishWork();
  const response = await webhookP;
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
});

async function waitUntil(predicate: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

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
