import { expect, test } from "bun:test";
import { PI_RPC_TOOLS } from "./pi";

test("RPC tool allowlist declares MCP, codemode, and tool_search", () => {
  expect(PI_RPC_TOOLS).toContain("mcp__*");
  expect(PI_RPC_TOOLS).toContain("codemode");
  expect(PI_RPC_TOOLS).toContain("tool_search");
  expect(PI_RPC_TOOLS).toContain("read");
  expect(PI_RPC_TOOLS).toContain("bash");
});
