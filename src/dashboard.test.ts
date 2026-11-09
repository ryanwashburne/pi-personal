import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserSession } from "./browser-session";
import type { Config } from "./config";
import { browserViewerPath, dashboardPath, googleOAuthCallbackPath } from "./dashboard";
import { upsertGoogleMcpServers } from "./google-mcp";
import { GOOGLE_AUTHORIZE_URL, writeGoogleTokens } from "./google-oauth";
import { liveViewFilePath } from "./live-view";
import { createDedupe } from "./dedupe";
import { listMcpServers } from "./mcp-config";
import { createGateway } from "./webhook";

const config: Config = {
  port: 8080,
  webhookPathSecret: "path-secret",
  dashboardPathSecret: "dash-secret",
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
  piProvider: "openrouter",
  piModel: "anthropic/claude-haiku-5.5",
  tailscaleAuthKey: undefined,
  tailscaleExitNode: undefined,
  tailscaleSocksPort: 1055,
};

function mockBrowser(dir: string): BrowserSession & { running: boolean; starts: number; stops: number } {
  const session = {
    running: false,
    starts: 0,
    stops: 0,
    status() {
      return {
        running: session.running,
        profileDir: join(dir, "browser-profile"),
        missing: [] as string[],
      };
    },
    async start() {
      session.starts += 1;
      session.running = true;
    },
    async stop() {
      session.stops += 1;
      session.running = false;
    },
    vncPort() {
      return 5900;
    },
  };
  return session;
}

async function setup(overrides: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-dashboard-"));
  const restarts: number[] = [];
  const browser = mockBrowser(dir);
  const gateway = await createGateway({
    config: {
      ...config,
      agentCwd: dir,
      mcpConfigPath: join(dir, "mcp.json"),
      userMcpPath: join(dir, "user-mcp.json"),
      googleOAuthTokenPath: join(dir, "google-oauth.json"),
      ...overrides,
    },
    userMcpPath: join(dir, "missing-user-mcp.json"),
    sendblue: {
      async sendTyping() {},
      async sendMessage() {},
    },
    pi: {
      async prompt() {
        return { kind: "reply", text: "unused" };
      },
      async restart() {
        restarts.push(1);
      },
      async stop() {},
    },
    browser,
    browserMcp: false,
    dedupe: await createDedupe(join(dir, "processed.json")),
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });
  return { gateway, restarts, browser, dir, mcpPath: join(dir, "mcp.json"), userPath: join(dir, "user-mcp.json") };
}

function dash(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, init);
}

test("serves HTML at the unguessable settings path", async () => {
  const { gateway, dir } = await setup();
  const path = dashboardPath(config);
  if (!path) throw new Error("dashboard path missing");
  const result = await gateway.handle(
    dash(path, { headers: { "x-forwarded-host": "abc.sprites.app", "x-forwarded-proto": "https" } }),
  );
  expect(readFileSync(liveViewFilePath(dir), "utf8")).toContain(
    "https://abc.sprites.app/settings/dash-secret/browser",
  );
  expect(result.status).toBe(200);
  expect(result.headers?.["content-type"]).toContain("text/html");
  expect(result.body).toContain("Add HTTP MCP");
  expect(result.body).toContain("Google Workspace");
  expect(result.body).toContain("missing — set GOOGLE_OAUTH_CLIENT_ID");
  expect(result.body).toContain("Playwright is always on");
  expect(result.body).toContain("Open live view");
  expect(result.body).toContain("Paste (⌘V / Ctrl+V)");
  expect(result.body).toContain("stopped");
});

test("does not serve a dashboard when DASHBOARD_SECRET is unset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-dashboard-off-"));
  const gateway = await createGateway({
    config: {
      ...config,
      dashboardPathSecret: undefined,
      agentCwd: dir,
      mcpConfigPath: join(dir, "mcp.json"),
      userMcpPath: join(dir, "user-mcp.json"),
    },
    sendblue: { async sendTyping() {}, async sendMessage() {} },
    pi: { async prompt() { return { kind: "reply" as const, text: "" }; }, async restart() {}, async stop() {} },
    userMcpPath: join(dir, "missing-user-mcp.json"),
    browserMcp: false,
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
  const { gateway, restarts, mcpPath, userPath } = await setup();
  const path = dashboardPath(config);
  if (!path) throw new Error("dashboard path missing");
  const posted = await gateway.handle(
    dash(path, {
      method: "POST",
      body: new URLSearchParams({
        action: "add",
        name: "notes",
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
      name: "notes",
      kind: "http",
      target: "https://mcp.example.com/mcp",
      hasAuth: true,
    },
  ]);
  expect(await listMcpServers(userPath)).toEqual([
    {
      name: "notes",
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

test("starts the Sprite browser from the settings form", async () => {
  const { gateway, browser } = await setup();
  const path = dashboardPath(config);
  if (!path) throw new Error("dashboard path missing");
  const posted = await gateway.handle(
    dash(path, {
      method: "POST",
      body: new URLSearchParams({ action: "browser-start" }),
    }),
  );
  expect(posted.status).toBe(303);
  expect(browser.starts).toBe(1);
  expect(browser.running).toBe(true);

  const page = await gateway.handle(dash(path));
  expect(page.body).toContain("running");
  expect(page.body).toContain("Tailscale");
  expect(page.body).toContain("missing — set TAILSCALE_AUTHKEY");
  expect(page.body).toContain("see Tailscale below");

  const viewerPath = browserViewerPath(config);
  if (!viewerPath) throw new Error("viewer path missing");
  const viewer = await gateway.handle(dash(viewerPath));
  expect(viewer.status).toBe(200);
  expect(viewer.body).toContain("streaming");
  expect(viewer.body).toContain(`${viewerPath}/ws`);
  expect(viewer.body).toContain("Connecting to Sprite display");
  expect(viewer.body).toContain("noVNC@v1.5.0/core/rfb.js");
  expect(viewer.body).toContain('wsProtocols: ["binary"]');
  expect(viewer.body).toContain(">Paste<");
  expect(viewer.body).toContain("clipboard.readText");
  expect(viewer.body).toContain("sendKey");
  expect(viewer.body).toContain("metaKey");
  expect(viewer.body).not.toContain("/lib/rfb.js");
  expect(viewer.body).not.toContain("nothing to stream");
});

test("settings page shows Tailscale status and last error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-dashboard-"));
  const gateway = await createGateway({
    config: {
      ...config,
      agentCwd: dir,
      mcpConfigPath: join(dir, "mcp.json"),
      userMcpPath: join(dir, "user-mcp.json"),
      tailscaleAuthKey: "tskey-auth-test",
      tailscaleExitNode: "ryans-macbook",
    },
    userMcpPath: join(dir, "missing-user-mcp.json"),
    sendblue: { async sendTyping() {}, async sendMessage() {} },
    pi: { async prompt() { return { kind: "reply" as const, text: "" }; }, async restart() {}, async stop() {} },
    browser: mockBrowser(dir),
    tailscale: {
      status: () => ({
        configured: true,
        running: false,
        hasAuthKey: true,
        exitNode: "ryans-macbook",
        error: "tailscale up failed (code=1)\nbad exit node",
      }),
      async start() {},
      async stop() {},
    },
    browserMcp: false,
    dedupe: await createDedupe(join(dir, "processed.json")),
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });
  const path = dashboardPath(config);
  if (!path) throw new Error("dashboard path missing");
  const page = await gateway.handle(dash(path));
  expect(page.body).toContain("ryans-macbook");
  expect(page.body).toContain("Auth key");
  expect(page.body).toContain(">set<");
  expect(page.body).toContain("bad exit node");
  expect(page.body).not.toContain("tskey-auth-test");
});

test("live view explains a crashed browser instead of a blank screen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-dashboard-"));
  const browser = mockBrowser(dir);
  browser.status = () => ({
    running: false,
    profileDir: join(dir, "browser-profile"),
    missing: [],
    error: "chromium exited (code=1)\nMissing X server",
  });
  const gateway = await createGateway({
    config: { ...config, agentCwd: dir, mcpConfigPath: join(dir, "mcp.json"), userMcpPath: join(dir, "user-mcp.json") },
    userMcpPath: join(dir, "missing-user-mcp.json"),
    sendblue: { async sendTyping() {}, async sendMessage() {} },
    pi: { async prompt() { return { kind: "reply" as const, text: "" }; }, async restart() {}, async stop() {} },
    browser,
    browserMcp: false,
    dedupe: await createDedupe(join(dir, "processed.json")),
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });
  const viewerPath = browserViewerPath(config);
  if (!viewerPath) throw new Error("viewer path missing");
  const viewer = await gateway.handle(
    dash(`${viewerPath}?notice=${encodeURIComponent("Browser is running.")}`),
  );
  expect(viewer.body).toContain("nothing to stream");
  expect(viewer.body).toContain("chromium exited (code=1)");
  expect(viewer.body).not.toContain("Browser is running.");
});

test("404s a guessed browser viewer path", async () => {
  const { gateway } = await setup();
  const result = await gateway.handle(dash("/settings/nope/browser"));
  expect(result.status).toBe(404);
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

test("writes the built-in Playwright MCP server and hides remove", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-dashboard-"));
  const gateway = await createGateway({
    config: { ...config, agentCwd: dir, mcpConfigPath: join(dir, "mcp.json"), userMcpPath: join(dir, "user-mcp.json") },
    userMcpPath: join(dir, "user-mcp.json"),
    sendblue: { async sendTyping() {}, async sendMessage() {} },
    pi: { async prompt() { return { kind: "reply" as const, text: "" }; }, async restart() {}, async stop() {} },
    browser: mockBrowser(dir),
    dedupe: await createDedupe(join(dir, "processed.json")),
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });
  const path = dashboardPath(config);
  if (!path) throw new Error("dashboard path missing");
  const page = await gateway.handle(dash(path));
  expect(page.body).toContain(">playwright<");
  expect(page.body).toContain("built-in");
  expect(page.body).toContain("playwright-mcp.ts");
  expect(page.body).not.toContain('name" value="playwright"');

  const removed = await gateway.handle(
    dash(path, {
      method: "POST",
      body: new URLSearchParams({ action: "remove", name: "playwright" }),
    }),
  );
  expect(removed.headers?.Location).toContain("error=");
  const listed = await listMcpServers(join(dir, "mcp.json"));
  expect(listed).toHaveLength(1);
  expect(listed[0]?.name).toBe("playwright");
  expect(listed[0]?.kind).toBe("stdio");
  expect(listed[0]?.target).toContain("playwright-mcp.ts");
});

test("rejects reserving the playwright MCP name for an HTTP server", async () => {
  const { gateway, restarts, mcpPath } = await setup();
  const path = dashboardPath(config);
  if (!path) throw new Error("dashboard path missing");
  const posted = await gateway.handle(
    dash(path, {
      method: "POST",
      body: new URLSearchParams({
        action: "add",
        name: "playwright",
        url: "https://example.com/mcp",
      }),
    }),
  );
  expect(posted.headers?.Location).toContain("error=");
  expect(restarts).toHaveLength(0);
  expect(await listMcpServers(mcpPath)).toEqual([]);
});

test("rejects reserving Google Workspace MCP names on the add form", async () => {
  const { gateway, restarts, mcpPath } = await setup();
  const path = dashboardPath(config);
  if (!path) throw new Error("dashboard path missing");
  const posted = await gateway.handle(
    dash(path, {
      method: "POST",
      body: new URLSearchParams({
        action: "add",
        name: "gmail",
        url: "https://example.com/mcp",
      }),
    }),
  );
  expect(posted.headers?.Location).toContain("error=");
  expect(restarts).toHaveLength(0);
  expect(await listMcpServers(mcpPath)).toEqual([]);
});

test("Connect Google redirects to Google OAuth with the settings callback", async () => {
  const { gateway, dir } = await setup({
    spriteUrl: "https://abc.sprites.app",
    googleOAuthClientId: "client.apps.googleusercontent.com",
    googleOAuthClientSecret: "client-secret",
  });
  const path = dashboardPath(config);
  if (!path) throw new Error("dashboard path missing");
  const page = await gateway.handle(dash(path));
  expect(page.body).toContain("https://abc.sprites.app/settings/dash-secret/google/callback");
  expect(page.body).toContain("Connect Google");
  expect(page.body).not.toContain("client-secret");

  const posted = await gateway.handle(
    dash(path, {
      method: "POST",
      body: new URLSearchParams({ action: "google-connect" }),
    }),
  );
  expect(posted.status).toBe(303);
  const location = posted.headers?.Location ?? "";
  expect(location.startsWith(GOOGLE_AUTHORIZE_URL)).toBe(true);
  const url = new URL(location);
  expect(url.searchParams.get("redirect_uri")).toBe("https://abc.sprites.app/settings/dash-secret/google/callback");
  expect(url.searchParams.get("client_id")).toBe("client.apps.googleusercontent.com");
  expect(url.searchParams.get("access_type")).toBe("offline");
  const pending = JSON.parse(await Bun.file(join(dir, "google-oauth-pending.json")).text()) as { state: string };
  expect(url.searchParams.get("state")).toBe(pending.state);
});

test("Google OAuth callback writes MCP servers and restarts Pi", async () => {
  const { gateway, restarts, mcpPath, dir } = await setup({
    spriteUrl: "https://abc.sprites.app",
    googleOAuthClientId: "client.apps.googleusercontent.com",
    googleOAuthClientSecret: "client-secret",
  });
  const path = dashboardPath(config);
  const callback = googleOAuthCallbackPath(config);
  if (!path || !callback) throw new Error("dashboard path missing");
  const started = await gateway.handle(
    dash(path, {
      method: "POST",
      body: new URLSearchParams({ action: "google-connect" }),
    }),
  );
  const state = new URL(started.headers?.Location ?? "").searchParams.get("state");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        access_token: "ya29.access",
        refresh_token: "1//refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
  try {
    const finished = await gateway.handle(dash(`${callback}?code=auth-code&state=${state}`));
    expect(finished.status).toBe(303);
    expect(finished.headers?.Location).toContain("notice=");
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(restarts.length).toBeGreaterThan(0);
  expect((await listMcpServers(mcpPath)).map((server) => server.name)).toEqual(["gmail", "calendar", "drive"]);
  const tokens = JSON.parse(await Bun.file(join(dir, "google-oauth.json")).text()) as { refreshToken: string };
  expect(tokens.refreshToken).toBe("1//refresh");

  const page = await gateway.handle(dash(path));
  expect(page.body).toContain(">connected<");
  expect(page.body).toContain("Disconnect");
  expect(page.body).toContain("gmailmcp.googleapis.com");
  expect(page.body).not.toContain("1//refresh");
  expect(page.body).not.toContain("ya29.access");
});

test("Disconnect Google removes MCP servers and tokens", async () => {
  const { gateway, mcpPath, dir } = await setup({
    spriteUrl: "https://abc.sprites.app",
    googleOAuthClientId: "client.apps.googleusercontent.com",
    googleOAuthClientSecret: "client-secret",
  });
  const path = dashboardPath(config);
  if (!path) throw new Error("dashboard path missing");
  await writeGoogleTokens(join(dir, "google-oauth.json"), {
    accessToken: "ya29.access",
    refreshToken: "1//refresh",
    expiresAt: Date.now() + 60 * 60_000,
  });
  await upsertGoogleMcpServers([mcpPath], "/bin/echo Bearer tok");
  await gateway.handle(
    dash(path, {
      method: "POST",
      body: new URLSearchParams({ action: "google-disconnect" }),
    }),
  );
  expect(await listMcpServers(mcpPath)).toEqual([]);
  expect(await Bun.file(join(dir, "google-oauth.json")).exists()).toBe(false);
});

