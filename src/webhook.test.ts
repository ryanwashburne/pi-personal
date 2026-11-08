import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { createDedupe } from "./dedupe";
import { createGateway, webhookPath } from "./webhook";

const config: Config = {
  port: 8080,
  webhookPathSecret: "path-secret",
  sendblueApiKeyId: "id",
  sendblueApiKeySecret: "secret",
  sendblueFromNumber: "+15551111111",
  sendblueWebhookSecret: "hook-secret",
  allowedPhone: "+15552222222",
  piCli: "pi",
  agentCwd: "/tmp",
  sessionDir: "/tmp",
  agentTimeoutMs: 1000,
  piProvider: undefined,
  piModel: undefined,
};

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pi-personal-"));
  const sent: string[] = [];
  const prompts: string[] = [];
  const gateway = await createGateway({
    config: { ...config, agentCwd: dir },
    sendblue: {
      async sendTyping() {},
      async sendMessage(_to, content) {
        sent.push(content);
      },
    },
    pi: {
      async prompt(message) {
        prompts.push(message);
        return "got it";
      },
      async stop() {},
    },
    dedupe: await createDedupe(join(dir, "processed.json")),
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });
  return { gateway, sent, prompts };
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
