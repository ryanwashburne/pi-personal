import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { PI_RPC_TOOLS } from "./pi";

test("RPC tool allowlist declares MCP, codemode, and tool_search", () => {
  expect(PI_RPC_TOOLS).toContain("mcp__*");
  expect(PI_RPC_TOOLS).toContain("codemode");
  expect(PI_RPC_TOOLS).toContain("tool_search");
  expect(PI_RPC_TOOLS).toContain("read");
  expect(PI_RPC_TOOLS).toContain("bash");
});

test("Pi workspace documents iMessage-safe replies", () => {
  const agentDir = join(import.meta.dir, "../agent");
  const system = readFileSync(join(agentDir, "SYSTEM.md"), "utf8");
  const agents = readFileSync(join(agentDir, "AGENTS.md"), "utf8");
  const imessage = readFileSync(join(agentDir, "imessage.md"), "utf8");

  expect(system).toMatch(/iMessage only/i);
  expect(system).toContain("imessage.md");
  expect(agents).toContain("imessage.md");
  expect(agents).toMatch(/iMessage only/i);

  expect(imessage).toMatch(/markdown renderer/i);
  expect(imessage).toMatch(/emoji/i);
  expect(imessage).toMatch(/bare URLs/i);
  expect(imessage).toMatch(/data detectors/i);
  expect(imessage).toMatch(/Does not render/i);
});
