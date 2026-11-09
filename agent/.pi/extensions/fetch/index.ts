/**
 * Keyless HTTP fetch for Pi (no search API key).
 * Inspired by rytswd/pi-agent-extensions fetch (MIT), stripped of TUI rendering.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_TIMEOUT_MS, runWebFetch } from "./run";

export default function fetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch",
    label: "Fetch",
    description:
      "Fetch a public http(s) URL and return text. Use this instead of bash/curl for articles and APIs. Do not use it for logins, MFA, or pages that need the shared Chrome cookies — those are Playwright MCP.",
    promptSnippet: "Fetch a public http(s) page or API without opening Chrome",
    promptGuidelines: [
      "Use fetch for public URLs and APIs. Use mcp__playwright__* when the page needs login, cookies, JavaScript, or the owner must see it.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "http or https URL" }),
      method: Type.Optional(Type.String({ description: "HTTP method (default GET)" })),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      body: Type.Optional(Type.String({ description: "Request body for POST/PUT/PATCH" })),
      timeoutMs: Type.Optional(
        Type.Number({ description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` }),
      ),
      textOnly: Type.Optional(
        Type.Boolean({
          description: "Strip HTML. Default: strip text/html, leave other types as-is.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await runWebFetch(
        {
          url: params.url,
          method: params.method,
          headers: params.headers,
          body: params.body,
          timeoutMs: params.timeoutMs,
          textOnly: params.textOnly,
        },
        signal,
      );
      if (!result.ok) {
        return { content: [{ type: "text", text: result.error }] };
      }
      const prefix = result.truncated ? `[truncated]\n` : "";
      return {
        content: [
          {
            type: "text",
            text: `${prefix}HTTP ${result.status} ${result.statusText}\n${result.text}`,
          },
        ],
      };
    },
  });
}
