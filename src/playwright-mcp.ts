import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_CDP_PORT } from "./browser-session";

export const BROWSER_ENSURE_PATH = "/browser/ensure";
export const DEFAULT_INTERNAL_PORT = 8081;

type SpawnFn = (command: string, args: string[], options?: Parameters<typeof spawn>[2]) => ChildProcess;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function internalListenPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.INTERNAL_PORT ?? DEFAULT_INTERNAL_PORT);
}

export function browserEnsureUrl(port: number): string {
  return `http://127.0.0.1:${port}${BROWSER_ENSURE_PATH}`;
}

export function playwrightCdpArgs(cdpPort = BROWSER_CDP_PORT): string[] {
  return [`--cdp-endpoint=http://127.0.0.1:${cdpPort}`];
}

export function defaultPlaywrightMcp(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [join(import.meta.dir, "playwright-mcp.ts")],
  };
}

export function resolvePlaywrightMcpCli(root = join(import.meta.dir, "..")): string {
  const cli = join(root, "node_modules/@playwright/mcp/cli.js");
  if (!existsSync(cli)) {
    throw new Error(`@playwright/mcp is not installed at ${cli}. Run bun install.`);
  }
  return cli;
}

export async function ensureSpriteBrowser(
  port = internalListenPort(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const response = await fetchImpl(browserEnsureUrl(port), { method: "POST" });
  if (!response.ok) {
    throw new Error(`Could not start Sprite Chromium: ${response.status} ${await response.text()}`);
  }
}

export async function runPlaywrightMcp(options?: {
  port?: number;
  fetchImpl?: FetchLike;
  spawnFn?: SpawnFn;
  cli?: string;
}): Promise<number> {
  await ensureSpriteBrowser(options?.port ?? internalListenPort(), options?.fetchImpl);
  const spawnFn = options?.spawnFn ?? spawn;
  const cli = options?.cli ?? resolvePlaywrightMcpCli();
  const child = spawnFn(process.execPath, [cli, ...playwrightCdpArgs()], { stdio: "inherit" });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`playwright-mcp exited (${signal})`));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

if (import.meta.main) {
  try {
    process.exit(await runPlaywrightMcp());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
