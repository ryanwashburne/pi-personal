import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type McpServer = {
  name: string;
  version?: string;
  instructions?: string;
  tools: McpTool[];
  call: (name: string, args: Record<string, unknown>) => Promise<McpToolResult | string>;
};

type JsonRpcSuccess = { jsonrpc: "2.0"; id: JsonRpcId; result: unknown };
type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string };
};

export async function serveMcpStdio(
  server: McpServer,
  io: { input?: Readable; output?: Writable } = {},
): Promise<void> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const rl = createInterface({ input });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      writeMessage(output, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }
    const response = await dispatchMcp(request, server);
    if (response) writeMessage(output, response);
  }
}

export async function dispatchMcp(
  request: JsonRpcRequest,
  server: McpServer,
): Promise<JsonRpcSuccess | JsonRpcFailure | undefined> {
  const method = request.method?.trim() ?? "";
  const id = request.id;
  if (id === undefined) {
    return undefined;
  }
  try {
    const result = await handleMethod(method, request.params, server);
    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Method not found")) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message } };
    }
    return { jsonrpc: "2.0", id, error: { code: -32603, message } };
  }
}

async function handleMethod(method: string, params: unknown, server: McpServer): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const protocolVersion = requestedProtocol(params);
      return {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: server.version ?? "1.0.0" },
        ...(server.instructions ? { instructions: server.instructions } : {}),
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: server.tools };
    case "tools/call":
      return callTool(server, params);
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      throw new Error(`Method not found: ${method || "(missing)"}`);
  }
}

async function callTool(server: McpServer, params: unknown): Promise<McpToolResult> {
  const raw = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    return { content: [{ type: "text", text: "Missing tool name." }], isError: true };
  }
  const args =
    raw.arguments && typeof raw.arguments === "object" && !Array.isArray(raw.arguments)
      ? (raw.arguments as Record<string, unknown>)
      : {};
  try {
    const result = await server.call(name, args);
    if (typeof result === "string") {
      return { content: [{ type: "text", text: result }] };
    }
    return result;
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

function requestedProtocol(params: unknown): string {
  if (params && typeof params === "object") {
    const version = (params as { protocolVersion?: unknown }).protocolVersion;
    if (typeof version === "string" && version.trim()) return version.trim();
  }
  return "2024-11-05";
}

function writeMessage(output: Writable, message: object): void {
  output.write(`${JSON.stringify(message)}\n`);
}
