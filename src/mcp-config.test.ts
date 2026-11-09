import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addHttpMcpServer,
  addHttpMcpServers,
  BROWSER_MCP_NAME,
  listMcpServers,
  listMcpServersFrom,
  migrateUserMcpToProject,
  removeMcpServer,
  syncMcpConfigFiles,
  upsertStdioMcpServer,
  validateMcpName,
} from "./mcp-config";

async function tempMcp() {
  const dir = await mkdtemp(join(tmpdir(), "mcp-config-"));
  return join(dir, "mcp.json");
}

test("rejects a bad MCP server name", () => {
  expect(validateMcpName("calendar")).toBeUndefined();
  expect(validateMcpName("has space")).toBeDefined();
});

test("adds an HTTP MCP server with a bearer token", async () => {
  const path = await tempMcp();
  await addHttpMcpServer(path, {
    name: "calendar",
    url: "https://example.com/mcp",
    bearerToken: "secret-token",
  });
  const listed = await listMcpServers(path);
  expect(listed).toEqual([
    { name: "calendar", kind: "http", target: "https://example.com/mcp", hasAuth: true },
  ]);
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    mcpServers: { calendar: { type?: string; exposure?: string; headers?: { Authorization?: string } } };
  };
  expect(raw.mcpServers.calendar.type).toBe("http");
  expect(raw.mcpServers.calendar.exposure).toBe("direct");
  expect(raw.mcpServers.calendar.headers?.Authorization).toBe("Bearer secret-token");
});

test("copies user-level MCP config into the project file when the project is empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-migrate-"));
  const userPath = join(dir, "user.json");
  const projectPath = join(dir, "project", "mcp.json");
  await addHttpMcpServer(userPath, { name: "docs", url: "https://docs.example/mcp" });
  expect(await migrateUserMcpToProject(projectPath, userPath)).toBe(true);
  expect(await listMcpServers(projectPath)).toEqual([
    { name: "docs", kind: "http", target: "https://docs.example/mcp", hasAuth: false },
  ]);
});

test("copies project MCP config into the user file when the user file is empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-migrate-user-"));
  const userPath = join(dir, "user.json");
  const projectPath = join(dir, "project.json");
  await addHttpMcpServer(projectPath, { name: "docs", url: "https://docs.example/mcp" });
  await syncMcpConfigFiles(projectPath, userPath);
  expect(await listMcpServers(userPath)).toEqual([
    { name: "docs", kind: "http", target: "https://docs.example/mcp", hasAuth: false },
  ]);
});

test("writes an HTTP MCP server to every given config path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-dual-"));
  const projectPath = join(dir, "project.json");
  const userPath = join(dir, "user.json");
  await addHttpMcpServers([projectPath, userPath], { name: "docs", url: "https://docs.example/mcp" });
  expect(await listMcpServersFrom([projectPath, userPath])).toEqual([
    { name: "docs", kind: "http", target: "https://docs.example/mcp", hasAuth: false },
  ]);
});

test("does not overwrite a project MCP file that already has servers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-migrate-keep-"));
  const userPath = join(dir, "user.json");
  const projectPath = join(dir, "project.json");
  await addHttpMcpServer(userPath, { name: "docs", url: "https://docs.example/mcp" });
  await addHttpMcpServer(projectPath, { name: "calendar", url: "https://cal.example/mcp" });
  expect(await migrateUserMcpToProject(projectPath, userPath)).toBe(false);
  expect(await listMcpServers(projectPath)).toEqual([
    { name: "calendar", kind: "http", target: "https://cal.example/mcp", hasAuth: false },
  ]);
});

test("removes an MCP server", async () => {
  const path = await tempMcp();
  await addHttpMcpServer(path, { name: "docs", url: "https://docs.example/mcp" });
  expect(await removeMcpServer(path, "docs")).toBe(true);
  expect(await listMcpServers(path)).toEqual([]);
});

test("upserts a stdio Playwright MCP server and refuses to remove it", async () => {
  const path = await tempMcp();
  await upsertStdioMcpServer(path, {
    name: BROWSER_MCP_NAME,
    command: "/usr/bin/bun",
    args: ["src/playwright-mcp.ts"],
  });
  expect(await listMcpServers(path)).toEqual([
    {
      name: "playwright",
      kind: "stdio",
      target: "/usr/bin/bun src/playwright-mcp.ts",
      hasAuth: false,
    },
  ]);
  expect(await removeMcpServer(path, BROWSER_MCP_NAME)).toBe(false);
  expect(await listMcpServers(path)).toHaveLength(1);
  await expect(
    addHttpMcpServer(path, { name: BROWSER_MCP_NAME, url: "https://example.com/mcp" }),
  ).rejects.toThrow(/reserved/);
});
