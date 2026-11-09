import { join } from "node:path";
import type { Config } from "./config";
import {
  GOOGLE_MCP_NAMES,
  addHttpMcpServer,
  mcpConfigPaths,
  removeMcpServer,
  type GoogleMcpName,
} from "./mcp-config";
import {
  defaultGooglePendingPath,
  defaultGoogleTokenPath,
  googleOAuthConfigured,
  googleOAuthConnected,
  type GoogleOAuthClient,
} from "./google-oauth";

export const GOOGLE_MCP_SERVERS: ReadonlyArray<{
  name: GoogleMcpName;
  url: string;
  description: string;
}> = [
  {
    name: "gmail",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    description: "Gmail: search, read, label, and draft mail. Cannot send.",
  },
  {
    name: "calendar",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    description: "Google Calendar: list, search, create, update, and delete events.",
  },
  {
    name: "drive",
    url: "https://drivemcp.googleapis.com/mcp/v1",
    description: "Google Drive: search, read, create, and copy files.",
  },
];

export function googleTokenPathFor(config: Pick<Config, "googleOAuthTokenPath">): string {
  return config.googleOAuthTokenPath?.trim() || defaultGoogleTokenPath();
}

export function googleOAuthClientFromConfig(
  config: Pick<Config, "googleOAuthClientId" | "googleOAuthClientSecret" | "googleOAuthTokenPath">,
): GoogleOAuthClient | undefined {
  const clientId = config.googleOAuthClientId?.trim() ?? "";
  const clientSecret = config.googleOAuthClientSecret?.trim() ?? "";
  if (!clientId || !clientSecret) return undefined;
  const tokenPath = googleTokenPathFor(config);
  return {
    clientId,
    clientSecret,
    tokenPath,
    pendingPath: defaultGooglePendingPath(tokenPath),
  };
}

export function googleAuthorizationCommand(scriptDir = import.meta.dir): string {
  return `${shellArg(process.execPath)} ${shellArg(join(scriptDir, "google-access-token.ts"))}`;
}

export async function googleWorkspaceStatus(
  config: Pick<Config, "googleOAuthClientId" | "googleOAuthClientSecret" | "googleOAuthTokenPath">,
): Promise<{ configured: boolean; connected: boolean }> {
  const client = googleOAuthClientFromConfig(config);
  if (!client || !googleOAuthConfigured(client)) {
    return { configured: false, connected: false };
  }
  return { configured: true, connected: await googleOAuthConnected(client.tokenPath) };
}

export async function syncGoogleWorkspaceMcp(
  config: Pick<Config, "mcpConfigPath" | "userMcpPath" | "googleOAuthClientId" | "googleOAuthClientSecret" | "googleOAuthTokenPath">,
  paths = mcpConfigPaths(config.mcpConfigPath, config.userMcpPath),
  authorizationCommand = googleAuthorizationCommand(),
): Promise<boolean> {
  const status = await googleWorkspaceStatus(config);
  if (status.connected) {
    await upsertGoogleMcpServers(paths, authorizationCommand);
    return true;
  }
  await removeGoogleMcpServers(paths);
  return false;
}

export async function upsertGoogleMcpServers(paths: string[], authorizationCommand: string): Promise<void> {
  const unique = uniquePaths(paths);
  for (const path of unique) {
    for (const server of GOOGLE_MCP_SERVERS) {
      await addHttpMcpServer(path, {
        name: server.name,
        url: server.url,
        description: server.description,
        authorizationCommand,
        allowReserved: true,
      });
    }
  }
}

export async function removeGoogleMcpServers(paths: string[]): Promise<boolean> {
  const unique = uniquePaths(paths);
  let removed = false;
  for (const path of unique) {
    for (const name of GOOGLE_MCP_NAMES) {
      if (await removeMcpServer(path, name)) removed = true;
    }
  }
  return removed;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim().length > 0))];
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
