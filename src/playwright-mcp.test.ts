import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import {
  browserEnsureUrl,
  defaultPlaywrightMcp,
  playwrightCdpArgs,
  resolvePlaywrightMcpCli,
  runPlaywrightMcp,
} from "./playwright-mcp";

test("Playwright MCP attaches to the Sprite CDP port", () => {
  expect(playwrightCdpArgs()).toEqual(["--cdp-endpoint=http://127.0.0.1:9222"]);
  expect(browserEnsureUrl(8081)).toBe("http://127.0.0.1:8081/browser/ensure");
  const spec = defaultPlaywrightMcp();
  expect(spec.command).toBe(process.execPath);
  expect(spec.args[0]?.endsWith("playwright-mcp.ts")).toBe(true);
  expect(resolvePlaywrightMcpCli().endsWith("node_modules/@playwright/mcp/cli.js")).toBe(true);
});

test("wrapper ensures Chromium then execs Playwright MCP against CDP", async () => {
  const fetches: string[] = [];
  const launched: Array<{ cmd: string; args: string[] }> = [];
  const fetchImpl = async (input: string) => {
    fetches.push(input);
    return new Response("{}", { status: 200 });
  };
  const child = {
    once(event: string, fn: (...args: unknown[]) => void) {
      if (event === "exit") queueMicrotask(() => fn(0, null));
    },
  } as unknown as ChildProcess;

  const code = await runPlaywrightMcp({
    port: 8081,
    fetchImpl,
    cli: "/tmp/playwright-mcp-cli.js",
    spawnFn: (cmd, args) => {
      launched.push({ cmd, args: [...args] });
      return child;
    },
  });
  expect(code).toBe(0);
  expect(fetches).toEqual(["http://127.0.0.1:8081/browser/ensure"]);
  expect(launched).toEqual([
    {
      cmd: process.execPath,
      args: ["/tmp/playwright-mcp-cli.js", "--cdp-endpoint=http://127.0.0.1:9222"],
    },
  ]);
});

test("wrapper fails if Chromium will not start", async () => {
  const fetchImpl = async () => new Response("Missing Xvfb", { status: 503 });
  await expect(
    runPlaywrightMcp({
      port: 8081,
      fetchImpl,
      spawnFn: () => {
        throw new Error("should not spawn");
      },
    }),
  ).rejects.toThrow("Could not start Sprite Chromium");
});
