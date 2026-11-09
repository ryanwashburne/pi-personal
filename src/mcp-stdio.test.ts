import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { dispatchMcp, serveMcpStdio, type McpServer } from "./mcp-stdio";

const server: McpServer = {
  name: "gmail",
  instructions: "draft only",
  tools: [
    {
      name: "search_emails",
      description: "Search mail",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    },
  ],
  async call(name, args) {
    if (name !== "search_emails") throw new Error(`Unknown tool: ${name}`);
    return JSON.stringify({ q: args.q, n: 1 });
  },
};

test("initialize advertises tools and echoes the client protocol", async () => {
  const result = await dispatchMcp(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pi", version: "1" } },
    },
    server,
  );
  expect(result).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "gmail", version: "1.0.0" },
      instructions: "draft only",
    },
  });
});

test("tools/list and tools/call round-trip", async () => {
  const listed = await dispatchMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, server);
  expect(listed).toMatchObject({ jsonrpc: "2.0", id: 2, result: { tools: server.tools } });
  const called = await dispatchMcp(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_emails", arguments: { q: "in:inbox" } } },
    server,
  );
  expect(called).toEqual({
    jsonrpc: "2.0",
    id: 3,
    result: { content: [{ type: "text", text: JSON.stringify({ q: "in:inbox", n: 1 }) }] },
  });
});

test("notifications have no response and unknown methods error", async () => {
  expect(await dispatchMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, server)).toBeUndefined();
  const missing = await dispatchMcp({ jsonrpc: "2.0", id: 9, method: "nope" }, server);
  expect(missing).toMatchObject({ jsonrpc: "2.0", id: 9, error: { code: -32601 } });
});

test("stdio framing is newline-delimited JSON-RPC", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    chunks.push(chunk);
  });
  const serving = serveMcpStdio(server, { input, output });
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
  );
  input.end();
  await serving;
  expect(chunks.join("")).toBe(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: server.tools } })}\n`,
  );
});
