import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHttpMcpServer, listMcpServers, removeMcpServer, validateMcpName } from "./mcp-config";

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

test("removes an MCP server", async () => {
  const path = await tempMcp();
  await addHttpMcpServer(path, { name: "docs", url: "https://docs.example/mcp" });
  expect(await removeMcpServer(path, "docs")).toBe(true);
  expect(await listMcpServers(path)).toEqual([]);
});
