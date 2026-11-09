import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addHttpMcpServer,
  listMcpServers,
  migrateUserMcpToProject,
  removeMcpServer,
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
    mcpServers: { calendar: { headers?: { Authorization?: string } } };
  };
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
