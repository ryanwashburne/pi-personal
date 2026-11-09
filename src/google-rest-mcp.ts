import type { Readable, Writable } from "node:stream";
import { googleAccessTokenFromEnv } from "./google-access-token";
import type { GoogleFetch } from "./google-oauth";
import { callGoogleTool, GOOGLE_MCP_INSTRUCTIONS, toolsForGoogleService } from "./google-rest";
import type { GoogleMcpName } from "./mcp-config";
import { GOOGLE_MCP_NAMES } from "./mcp-config";
import { serveMcpStdio } from "./mcp-stdio";

export function parseGoogleMcpService(value: string | undefined): GoogleMcpName {
  const name = value?.trim();
  if ((GOOGLE_MCP_NAMES as readonly string[]).includes(name ?? "")) {
    return name as GoogleMcpName;
  }
  throw new Error("Usage: google-rest-mcp.ts <gmail|calendar|drive|search>");
}

export async function serveGoogleRestMcp(
  service: GoogleMcpName,
  options?: {
    input?: Readable;
    output?: Writable;
    token?: () => Promise<string>;
    fetchImpl?: GoogleFetch;
  },
): Promise<void> {
  const token = options?.token ?? googleAccessTokenFromEnv;
  await serveMcpStdio(
    {
      name: service,
      instructions: GOOGLE_MCP_INSTRUCTIONS[service],
      tools: toolsForGoogleService(service),
      call: (name, args) =>
        callGoogleTool(service, name, args, { token, fetchImpl: options?.fetchImpl }),
    },
    { input: options?.input, output: options?.output },
  );
}

if (import.meta.main) {
  try {
    await serveGoogleRestMcp(parseGoogleMcpService(process.argv[2]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
