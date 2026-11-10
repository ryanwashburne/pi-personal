import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { writeGoogleTokens } from "./google-oauth";
import { googleAccessTokenFromEnv } from "./google-access-token";
import {
  defaultGoogleMcp,
  GOOGLE_MCP_SERVERS,
  removeGoogleMcpServers,
  syncGoogleWorkspaceMcp,
  upsertGoogleMcpServers,
} from "./google-mcp";
import { addHttpMcpServer, listMcpServers } from "./mcp-config";

const baseConfig: Config = {
  port: 8080,
  webhookPathSecret: "path-secret",
  dashboardPathSecret: "dash-secret",
  spriteUrl: "https://abc.sprites.app",
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

test("upserts Gmail, Calendar, Drive, and search as local stdio MCP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "google-mcp-"));
  const path = join(dir, "mcp.json");
  await upsertGoogleMcpServers([path], "/tmp/pi-personal/src");
  const listed = await listMcpServers(path);
  expect(listed.map((server) => server.name)).toEqual(["gmail", "calendar", "drive", "search"]);
  expect(listed.every((server) => server.kind === "stdio")).toBe(true);
  expect(listed.map((server) => server.target)).toEqual(
    GOOGLE_MCP_SERVERS.map((server) => `${process.execPath} /tmp/pi-personal/src/google-rest-mcp.ts ${server.name}`),
  );
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    mcpServers: Record<string, { description?: string; url?: string; headers?: unknown; exposure?: string }>;
  };
  expect(raw.mcpServers.gmail.exposure).toBe("direct");
  expect(raw.mcpServers.gmail.url).toBeUndefined();
  expect(raw.mcpServers.gmail.headers).toBeUndefined();
  expect(raw.mcpServers.gmail.description).toContain("Cannot send");
  expect(raw.mcpServers.search.description).toContain("Gmail, Calendar, and Drive");
});

test("replaces leftover hosted Google HTTP MCP entries with stdio", async () => {
  const dir = await mkdtemp(join(tmpdir(), "google-mcp-migrate-"));
  const path = join(dir, "mcp.json");
  await addHttpMcpServer(path, {
    name: "gmail",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    authorizationCommand: "/bin/echo Bearer tok",
    allowReserved: true,
  });
  await upsertGoogleMcpServers([path], "/tmp/pi-personal/src");
  const listed = await listMcpServers(path);
  expect(listed).toEqual([
    {
      name: "gmail",
      kind: "stdio",
      target: `${process.execPath} /tmp/pi-personal/src/google-rest-mcp.ts gmail`,
      hasAuth: false,
    },
    {
      name: "calendar",
      kind: "stdio",
      target: `${process.execPath} /tmp/pi-personal/src/google-rest-mcp.ts calendar`,
      hasAuth: false,
    },
    {
      name: "drive",
      kind: "stdio",
      target: `${process.execPath} /tmp/pi-personal/src/google-rest-mcp.ts drive`,
      hasAuth: false,
    },
    {
      name: "search",
      kind: "stdio",
      target: `${process.execPath} /tmp/pi-personal/src/google-rest-mcp.ts search`,
      hasAuth: false,
    },
  ]);
});

test("sync writes Google MCP servers only while a refresh token exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "google-sync-"));
  const mcpPath = join(dir, "mcp.json");
  const tokenPath = join(dir, "google-oauth.json");
  const config: Config = {
    ...baseConfig,
    mcpConfigPath: mcpPath,
    userMcpPath: join(dir, "user-mcp.json"),
    googleOAuthClientId: "client.apps.googleusercontent.com",
    googleOAuthClientSecret: "client-secret",
    googleOAuthTokenPath: tokenPath,
  };
  expect(await syncGoogleWorkspaceMcp(config, [mcpPath])).toBe(false);
  expect(await listMcpServers(mcpPath)).toEqual([]);

  await writeGoogleTokens(tokenPath, {
    accessToken: "ya29.access",
    refreshToken: "1//refresh",
    expiresAt: Date.now() + 60 * 60_000,
  });
  expect(await syncGoogleWorkspaceMcp(config, [mcpPath])).toBe(true);
  expect((await listMcpServers(mcpPath)).map((server) => server.name)).toEqual([
    "gmail",
    "calendar",
    "drive",
    "search",
  ]);

  await removeGoogleMcpServers([mcpPath]);
  expect(await listMcpServers(mcpPath)).toEqual([]);
});

test("google-access-token prints a Bearer token from env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "google-token-cli-"));
  const tokenPath = join(dir, "google-oauth.json");
  await writeGoogleTokens(tokenPath, {
    accessToken: "ya29.from-file",
    refreshToken: "1//refresh",
    expiresAt: Date.now() + 60 * 60_000,
  });
  const token = await googleAccessTokenFromEnv({
    GOOGLE_OAUTH_CLIENT_ID: "client.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GOOGLE_OAUTH_TOKEN_PATH: tokenPath,
  });
  expect(token).toBe("ya29.from-file");

  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "google-access-token.ts")],
    env: {
      ...process.env,
      GOOGLE_OAUTH_CLIENT_ID: "client.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_TOKEN_PATH: tokenPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await new Response(child.stdout).text()).toBe("Bearer ya29.from-file");
  expect(await child.exited).toBe(0);
});

test("default Google MCP points bun at google-rest-mcp.ts", () => {
  const spec = defaultGoogleMcp("gmail", "/tmp/pi-personal/src");
  expect(spec.command).toBe(process.execPath);
  expect(spec.args).toEqual(["/tmp/pi-personal/src/google-rest-mcp.ts", "gmail"]);
  expect(spec.description).toContain("Cannot send");
});
