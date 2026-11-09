import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { createDedupe } from "./dedupe";
import { HEARTBEAT_OK } from "./heartbeat";
import { liveViewPromptNote } from "./live-view";
import type { PiAgent } from "./pi";
import { socksHostFromUrl } from "./home-push";
import {
  handleRoutineAdmin,
  routinePath,
  routinePrompt,
  routinesCatalogPath,
  ROUTINES_SESSION_ID,
} from "./routines";
import { loadRoutines } from "./routine-store";
import { createGateway, webhookPath } from "./webhook";
import { parseRoutineAction, runRoutineTool } from "../agent/.pi/extensions/routine/run";

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

async function setup(
  overrides: Partial<Config> = {},
  extras: { pi?: Partial<PiAgent>; routinesPi?: Partial<PiAgent> } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-routines-"));
  const sent: string[] = [];
  const prompts: string[] = [];
  const routinePrompts: string[] = [];
  const holds: string[] = [];
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
    pi: { ...defaultPi, ...extras.pi },
    routinesPi: extras.routinesPi
      ? {
          async prompt(message) {
            routinePrompts.push(message);
            return { kind: "reply", text: HEARTBEAT_OK };
          },
          async restart() {},
          async stop() {},
          ...extras.routinesPi,
        }
      : undefined,
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
  return { gateway, sent, prompts, routinePrompts, holds, dir };
}

function fire(
  body: unknown,
  path = routinePath(config) ?? "/routine/beat-secret",
): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("socksHostFromUrl reads host:port from a socks5 URL", () => {
  expect(socksHostFromUrl("socks5://127.0.0.1:1055")).toBe("127.0.0.1:1055");
  expect(socksHostFromUrl(undefined)).toBeUndefined();
});

test("routine paths follow the heartbeat secret", () => {
  expect(routinePath({ heartbeatPathSecret: undefined })).toBeUndefined();
  expect(routinePath(config)).toBe("/routine/beat-secret");
  expect(routinesCatalogPath(config)).toBe("/routines/beat-secret");
});

test("unknown routine path is 404", async () => {
  const { gateway, prompts } = await setup();
  const result = await gateway.handle(fire({ prompt: "hi" }, "/routine/nope"));
  expect(result.status).toBe(404);
  expect(result.work).toBeUndefined();
  expect(prompts).toEqual([]);
});

test("silent HEARTBEAT_OK does not iMessage", async () => {
  const { gateway, sent, routinePrompts, holds } = await setup({}, { routinesPi: {} });
  const result = await gateway.handle(
    fire({ id: "weekend-spend", prompt: "summarize weekend spending", mode: "always" }),
  );
  expect(result.status).toBe(200);
  expect(result.body).toBe("ok");
  await result.work?.();
  expect(routinePrompts).toHaveLength(1);
  expect(routinePrompts[0]).toContain("summarize weekend spending");
  expect(routinePrompts[0]).toContain("Follow ROUTINES.md");
  expect(sent).toEqual([]);
  expect(holds).toEqual(["hold", "release"]);
});

test("a real routine reply iMessages even in always mode", async () => {
  const { gateway, sent } = await setup({}, {
    routinesPi: {
      async prompt() {
        return { kind: "reply", text: "You spent $42 this weekend." };
      },
    },
  });
  const result = await gateway.handle(
    fire({ id: "weekend-spend", prompt: "summarize weekend spending", mode: "always" }),
  );
  await result.work?.();
  expect(sent).toEqual(["You spent $42 this weekend."]);
});

test("silent mode still iMessages a real reply", async () => {
  const { gateway, sent } = await setup({}, {
    routinesPi: {
      async prompt() {
        return { kind: "reply", text: "The price dropped." };
      },
    },
  });
  const result = await gateway.handle(fire({ id: "price-watch", prompt: "watch the price", mode: "silent" }));
  await result.work?.();
  expect(sent).toEqual(["The price dropped."]);
});

test("routine uses the routines Pi session when provided", async () => {
  const { gateway, prompts, routinePrompts } = await setup({}, { routinesPi: {} });
  const result = await gateway.handle(fire({ prompt: "do the thing" }));
  await result.work?.();
  expect(prompts).toEqual([]);
  expect(routinePrompts[0]).toContain("do the thing");
  expect(ROUTINES_SESSION_ID).toBe("routines");
});

test("routine prefixes the live view URL when known", async () => {
  const liveViewUrl = "https://abc.sprites.app/settings/dash-secret/browser";
  const { gateway, prompts } = await setup({
    dashboardPathSecret: "dash-secret",
    spriteUrl: "https://abc.sprites.app",
  });
  const result = await gateway.handle(fire({ id: "job", prompt: "check it", mode: "silent" }));
  await result.work?.();
  expect(prompts).toEqual([
    routinePrompt({ id: "job", prompt: "check it", mode: "silent" }, liveViewUrl),
  ]);
  expect(prompts[0]).toContain(liveViewPromptNote(liveViewUrl));
});

test("routine returns busy when a text is already in flight", async () => {
  let finish: (value: { kind: "reply"; text: string }) => void = () => {};
  const first = new Promise<{ kind: "reply"; text: string }>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const { gateway, sent, prompts } = await setup({}, {
    pi: {
      async prompt(message) {
        prompts.push(message);
        calls += 1;
        if (calls === 1) return first;
        return { kind: "reply", text: "should not run" };
      },
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
  const routine = await gateway.handle(fire({ prompt: "later" }));
  expect(routine.status).toBe(200);
  expect(routine.body).toBe("busy");
  expect(routine.work).toBeUndefined();
  finish({ kind: "reply", text: "hi" });
  await textWork;
  expect(prompts).toHaveLength(1);
  expect(sent).toEqual(["hi"]);
});

test("invalid routine fire body is 400", async () => {
  const { gateway } = await setup();
  const result = await gateway.handle(fire({ mode: "silent" }));
  expect(result.status).toBe(400);
  expect(result.body).toMatch(/prompt/i);
});

test("catalog GET returns stored routines", async () => {
  const { gateway, dir } = await setup();
  const pushed: string[] = [];
  const admin = await handleRoutineAdmin(
    new Request("http://127.0.0.1/routines/weekend-spend", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Weekend spend",
        cron: "0 8 * * 1",
        prompt: "summarize weekend spending",
        mode: "always",
      }),
    }),
    {
      config: { ...config, agentCwd: dir },
      async push(action, routine) {
        pushed.push(`${action}:${"id" in routine ? routine.id : ""}`);
        return { pushed: true };
      },
    },
  );
  expect(admin?.status).toBe(200);
  expect(pushed).toEqual(["upsert:weekend-spend"]);
  const stored = await loadRoutines(dir);
  expect(stored).toHaveLength(1);
  expect(stored[0]?.cron).toBe("0 8 * * 1");

  const catalog = await gateway.handle(new Request(`http://localhost${routinesCatalogPath(config)}`));
  expect(catalog.status).toBe(200);
  const body = JSON.parse(catalog.body) as { routines: Array<{ id: string }> };
  expect(body.routines[0]?.id).toBe("weekend-spend");

  const listed = await handleRoutineAdmin(new Request("http://127.0.0.1/routines"), {
    config: { ...config, agentCwd: dir },
  });
  expect(listed?.status).toBe(200);
  expect(listed?.body).toContain("weekend-spend");

  const removed = await handleRoutineAdmin(
    new Request("http://127.0.0.1/routines/weekend-spend", { method: "DELETE" }),
    {
      config: { ...config, agentCwd: dir },
      async push(action, routine) {
        pushed.push(`${action}:${"id" in routine ? routine.id : ""}`);
        return { pushed: true };
      },
    },
  );
  expect(removed?.status).toBe(200);
  expect(pushed).toEqual(["upsert:weekend-spend", "delete:weekend-spend"]);
  expect(await loadRoutines(dir)).toEqual([]);
});

test("loopback upsert rejects bad cron", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-routines-bad-"));
  const result = await handleRoutineAdmin(
    new Request("http://127.0.0.1/routines/bad-job", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cron: "every monday", prompt: "nope" }),
    }),
    { config: { ...config, agentCwd: dir } },
  );
  expect(result?.status).toBe(400);
  expect(result?.body).toMatch(/cron/i);
  expect(await loadRoutines(dir)).toEqual([]);
});

test("routine tool talks to loopback only", async () => {
  parseRoutineAction("upsert");
  const calls: Array<{ url: string; method?: string }> = [];
  const text = await runRoutineTool(
    {
      action: "upsert",
      id: "weekend-spend",
      cron: "0 8 * * 1",
      prompt: "summarize weekend spending",
      mode: "always",
    },
    {
      env: { INTERNAL_PORT: "8099" },
      async fetchFn(url, init) {
        calls.push({ url, method: init?.method });
        return new Response(JSON.stringify({ ok: true, pushed: false, error: "Tailscale is not configured." }), {
          status: 200,
        });
      },
    },
  );
  expect(calls).toEqual([{ url: "http://127.0.0.1:8099/routines/weekend-spend", method: "PUT" }]);
  expect(text).toContain("ok");
});

test("home-daemon.py cron self-test passes", () => {
  const proc = Bun.spawnSync(["python3", join(import.meta.dir, "../scripts/home-daemon.py"), "self-test"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
  expect(proc.stderr.toString()).toBe("");
  expect(proc.stdout.toString()).toContain("self-test ok");
});

test("install-home.sh copies the python scheduler", async () => {
  const script = await Bun.file(join(import.meta.dir, "../scripts/install-home.sh")).text();
  expect(script).toContain("home-daemon.py");
  expect(script).toContain("exec python3");
  expect(script).toContain("python_daemon register");
  const syntax = Bun.spawnSync(["bash", "-n", join(import.meta.dir, "../scripts/install-home.sh")]);
  expect(syntax.exitCode).toBe(0);
  const compile = Bun.spawnSync(["python3", "-m", "py_compile", join(import.meta.dir, "../scripts/home-daemon.py")]);
  expect(compile.exitCode).toBe(0);
});
