import { join } from "node:path";
import type { Config } from "./config";
import {
  GOOGLE_MCP_NAMES,
  mcpConfigPaths,
  removeMcpServer,
  upsertStdioMcpServer,
  type AddStdioMcpServer,
  type GoogleMcpName,
} from "./mcp-config";
import {
  defaultGooglePendingPath,
  defaultGoogleTokenPath,
  googleOAuthConfigured,
  googleOAuthConnected,
  type GoogleOAuthClient,
} from "./google-oauth";
import { GOOGLE_MCP_INSTRUCTIONS } from "./google-rest";

export const GOOGLE_MCP_SERVERS: ReadonlyArray<{
  name: GoogleMcpName;
  description: string;
}> = GOOGLE_MCP_NAMES.map((name) => ({
  name,
  description: GOOGLE_MCP_INSTRUCTIONS[name],
}));

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

export function defaultGoogleMcp(
  service: GoogleMcpName,
  scriptDir = import.meta.dir,
): AddStdioMcpServer {
  return {
    name: service,
    command: process.execPath,
    args: [join(scriptDir, "google-rest-mcp.ts"), service],
    description: GOOGLE_MCP_INSTRUCTIONS[service],
  };
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
): Promise<boolean> {
  const status = await googleWorkspaceStatus(config);
  if (status.connected) {
    await upsertGoogleMcpServers(paths);
    return true;
  }
  await removeGoogleMcpServers(paths);
  return false;
}

export async function upsertGoogleMcpServers(
  paths: string[],
  scriptDir = import.meta.dir,
): Promise<void> {
  const unique = uniquePaths(paths);
  for (const path of unique) {
    for (const name of GOOGLE_MCP_NAMES) {
      await upsertStdioMcpServer(path, defaultGoogleMcp(name, scriptDir));
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
