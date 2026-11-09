import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { writeGoogleTokens } from "./google-oauth";
import { googleAccessTokenFromEnv } from "./google-access-token";
import {
  GOOGLE_MCP_SERVERS,
  googleAuthorizationCommand,
  removeGoogleMcpServers,
  syncGoogleWorkspaceMcp,
  upsertGoogleMcpServers,
} from "./google-mcp";
import { listMcpServers } from "./mcp-config";

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

test("upserts Gmail, Calendar, Drive, and Universal Search MCP entries with a token command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "google-mcp-"));
  const path = join(dir, "mcp.json");
  await upsertGoogleMcpServers([path], "/bin/echo Bearer tok");
  const listed = await listMcpServers(path);
  expect(listed.map((server) => server.name)).toEqual(["gmail", "calendar", "drive", "search"]);
  expect(listed.every((server) => server.hasAuth)).toBe(true);
  expect(listed.map((server) => server.target)).toEqual(GOOGLE_MCP_SERVERS.map((server) => server.url));
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    mcpServers: Record<string, { description?: string; headers?: { Authorization?: string }; exposure?: string }>;
  };
  expect(raw.mcpServers.gmail.exposure).toBe("direct");
  expect(raw.mcpServers.gmail.description).toContain("Cannot send");
  expect(raw.mcpServers.gmail.headers?.Authorization).toBe("!/bin/echo Bearer tok");
  expect(raw.mcpServers.search.description).toContain("Universal Search");
  expect(listed.find((server) => server.name === "search")?.target).toBe(
    "https://workspacemcp.googleapis.com/mcp/v1",
  );
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
  expect(await syncGoogleWorkspaceMcp(config, [mcpPath], "/bin/echo Bearer tok")).toBe(false);
  expect(await listMcpServers(mcpPath)).toEqual([]);

  await writeGoogleTokens(tokenPath, {
    accessToken: "ya29.access",
    refreshToken: "1//refresh",
    expiresAt: Date.now() + 60 * 60_000,
  });
  expect(await syncGoogleWorkspaceMcp(config, [mcpPath], "/bin/echo Bearer tok")).toBe(true);
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

test("authorization command quotes the bun path", () => {
  const command = googleAuthorizationCommand("/tmp/pi-personal/src");
  expect(command.startsWith("'")).toBe(true);
  expect(command).toContain("google-access-token.ts");
});
