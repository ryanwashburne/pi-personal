import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type McpServerKind = "http" | "stdio";

export type ListedMcpServer = {
  name: string;
  kind: McpServerKind;
  target: string;
  hasAuth: boolean;
};

export const BROWSER_MCP_NAME = "playwright";
export const GOOGLE_MCP_NAMES = ["gmail", "calendar", "drive", "search"] as const;
export type GoogleMcpName = (typeof GOOGLE_MCP_NAMES)[number];

export type AddHttpMcpServer = {
  name: string;
  url: string;
  bearerToken?: string;
  description?: string;
  authorizationCommand?: string;
  allowReserved?: boolean;
};

export type AddStdioMcpServer = {
  name: string;
  command: string;
  args?: string[];
  description?: string;
};

export function isBuiltinMcpServer(name: string): boolean {
  return name.trim() === BROWSER_MCP_NAME;
}

export function isGoogleMcpServer(name: string): boolean {
  return (GOOGLE_MCP_NAMES as readonly string[]).includes(name.trim());
}

export function isReservedMcpName(name: string): boolean {
  return isBuiltinMcpServer(name) || isGoogleMcpServer(name);
}

type McpFile = {
  mcpServers?: Record<string, unknown>;
};

export function validateMcpName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) {
    return "Name must start with a letter or digit and use only letters, digits, _ or -.";
  }
  return undefined;
}

export function validateMcpUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "URL must be a full http(s) address.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "URL must start with https:// or http://.";
  }
  return undefined;
}

export function defaultUserMcpPath(): string {
  return join(homedir(), ".pi/agent/mcp.json");
}

export function mcpConfigPaths(projectPath: string, userPath: string): string[] {
  return [...new Set([userPath, projectPath].filter((path) => path.trim().length > 0))];
}

export async function migrateUserMcpToProject(
  projectPath: string,
  userPath?: string,
): Promise<boolean> {
  const from = userPath ?? defaultUserMcpPath();
  if (projectPath === from) return false;
  if ((await listMcpServers(projectPath)).length > 0) return false;
  if ((await listMcpServers(from)).length === 0) return false;
  await mkdir(dirname(projectPath), { recursive: true });
  await copyFile(from, projectPath);
  return true;
}

export async function syncMcpConfigFiles(projectPath: string, userPath: string): Promise<void> {
  await migrateUserMcpToProject(projectPath, userPath);
  await migrateUserMcpToProject(userPath, projectPath);
}

export async function listMcpServersFrom(paths: string[]): Promise<ListedMcpServer[]> {
  const byName = new Map<string, ListedMcpServer>();
  for (const path of [...new Set(paths.filter((entry) => entry.trim().length > 0))]) {
    for (const server of await listMcpServers(path)) {
      byName.set(server.name, server);
    }
  }
  return [...byName.values()];
}

export async function addHttpMcpServers(paths: string[], input: AddHttpMcpServer): Promise<void> {
  const unique = [...new Set(paths.filter((path) => path.trim().length > 0))];
  if (unique.length === 0) throw new Error("No MCP config path to write.");
  for (const path of unique) {
    await addHttpMcpServer(path, input);
  }
}

export async function upsertStdioMcpServers(paths: string[], input: AddStdioMcpServer): Promise<void> {
  const unique = [...new Set(paths.filter((path) => path.trim().length > 0))];
  if (unique.length === 0) throw new Error("No MCP config path to write.");
  for (const path of unique) {
    await upsertStdioMcpServer(path, input);
  }
}

export async function removeMcpServers(paths: string[], name: string): Promise<boolean> {
  const unique = [...new Set(paths.filter((path) => path.trim().length > 0))];
  const results = await Promise.all(unique.map((path) => removeMcpServer(path, name)));
  return results.some(Boolean);
}

export async function listMcpServers(path: string): Promise<ListedMcpServer[]> {
  const file = await readMcpFile(path);
  const servers = file.mcpServers ?? {};
  const listed: ListedMcpServer[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.url === "string" && entry.url.trim()) {
      listed.push({
        name,
        kind: "http",
        target: entry.url.trim(),
        hasAuth: hasAuth(entry),
      });
      continue;
    }
    if (typeof entry.command === "string" && entry.command.trim()) {
      const args = Array.isArray(entry.args)
        ? entry.args.filter((arg): arg is string => typeof arg === "string")
        : [];
      listed.push({
        name,
        kind: "stdio",
        target: [entry.command.trim(), ...args].join(" "),
        hasAuth: hasAuth(entry),
      });
    }
  }
  return listed;
}

export async function addHttpMcpServer(path: string, input: AddHttpMcpServer): Promise<void> {
  const nameError = validateMcpName(input.name);
  if (nameError) throw new Error(nameError);
  if (!input.allowReserved && isReservedMcpName(input.name)) {
    throw new Error(reservedMcpNameError(input.name));
  }
  const urlError = validateMcpUrl(input.url);
  if (urlError) throw new Error(urlError);

  const file = await readMcpFile(path);
  const servers = { ...(file.mcpServers ?? {}) };
  const existing =
    servers[input.name.trim()] && typeof servers[input.name.trim()] === "object"
      ? (servers[input.name.trim()] as Record<string, unknown>)
      : {};

  const next: Record<string, unknown> = {
    ...existing,
    type: "http",
    url: input.url.trim(),
    exposure: "direct",
  };
  delete next.command;
  delete next.args;

  const description = input.description?.trim();
  if (description) next.description = description;

  const headers =
    existing.headers && typeof existing.headers === "object"
      ? { ...(existing.headers as Record<string, unknown>) }
      : {};
  const command = input.authorizationCommand?.trim();
  const token = input.bearerToken?.trim();
  if (command) {
    headers.Authorization = `!${command}`;
    next.headers = headers;
  } else if (token) {
    headers.Authorization = `Bearer ${token}`;
    next.headers = headers;
  }

  servers[input.name.trim()] = next;
  await writeMcpFile(path, { ...file, mcpServers: servers });
}

export async function upsertStdioMcpServer(path: string, input: AddStdioMcpServer): Promise<void> {
  const nameError = validateMcpName(input.name);
  if (nameError) throw new Error(nameError);

  const file = await readMcpFile(path);
  const servers = { ...(file.mcpServers ?? {}) };
  const existing =
    servers[input.name.trim()] && typeof servers[input.name.trim()] === "object"
      ? (servers[input.name.trim()] as Record<string, unknown>)
      : {};

  const next: Record<string, unknown> = {
    ...existing,
    command: input.command,
    args: input.args ?? [],
    exposure: "direct",
  };
  delete next.url;
  delete next.headers;
  delete next.type;

  const description = input.description?.trim();
  if (description) next.description = description;

  servers[input.name.trim()] = next;
  await writeMcpFile(path, { ...file, mcpServers: servers });
}

export async function removeMcpServer(path: string, name: string): Promise<boolean> {
  if (isBuiltinMcpServer(name)) return false;
  const file = await readMcpFile(path);
  const servers = { ...(file.mcpServers ?? {}) };
  if (!(name in servers)) return false;
  delete servers[name];
  await writeMcpFile(path, { ...file, mcpServers: servers });
  return true;
}

async function readMcpFile(path: string): Promise<McpFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as McpFile;
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

async function writeMcpFile(path: string, file: McpFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
}

export function reservedMcpNameError(name: string): string {
  if (isBuiltinMcpServer(name)) {
    return `Name ${BROWSER_MCP_NAME} is reserved for Sprite Chromium.`;
  }
  if (isGoogleMcpServer(name)) {
    return "gmail, calendar, drive, and search are reserved for Google. Connect them on this page.";
  }
  return `Name ${name.trim()} is reserved.`;
}

function hasAuth(entry: Record<string, unknown>): boolean {
  if (entry.headers && typeof entry.headers === "object") {
    const headers = entry.headers as Record<string, unknown>;
    if (typeof headers.Authorization === "string" && headers.Authorization.trim()) return true;
  }
  if (entry.env && typeof entry.env === "object" && Object.keys(entry.env).length > 0) return true;
  return false;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
