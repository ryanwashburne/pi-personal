import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleBrowserEnsure } from "./browser-ensure";
import type { BrowserSession, BrowserStartOptions } from "./browser-session";

function mockBrowser(dir: string): BrowserSession & { starts: BrowserStartOptions[]; error?: string } {
  const session = {
    starts: [] as BrowserStartOptions[],
    running: false,
    error: undefined as string | undefined,
    status() {
      return {
        running: session.running,
        profileDir: join(dir, "browser-profile"),
        missing: [] as string[],
        error: session.error,
      };
    },
    async start(options?: BrowserStartOptions) {
      session.starts.push(options ?? {});
      if (session.error) throw new Error(session.error);
      session.running = true;
    },
    async stop() {
      session.running = false;
    },
    vncPort() {
      return 5900;
    },
  };
  return session;
}

test("loopback ensure starts Chromium without a Sprite hold", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ensure-"));
  const browser = mockBrowser(dir);
  const result = await handleBrowserEnsure(new Request("http://127.0.0.1/browser/ensure", { method: "POST" }), browser);
  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ running: true, profileDir: join(dir, "browser-profile") });
  expect(browser.starts).toEqual([{ hold: false }]);
});

test("ensure 404s other paths and 405s GET", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ensure-"));
  const browser = mockBrowser(dir);
  const missing = await handleBrowserEnsure(new Request("http://127.0.0.1/nope", { method: "POST" }), browser);
  expect(missing.status).toBe(404);
  const get = await handleBrowserEnsure(new Request("http://127.0.0.1/browser/ensure"), browser);
  expect(get.status).toBe(405);
  expect(browser.starts).toEqual([]);
});

test("ensure returns the Chromium start error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ensure-"));
  const browser = mockBrowser(dir);
  browser.error = "Missing Xvfb, x11vnc, chromium";
  const result = await handleBrowserEnsure(new Request("http://127.0.0.1/browser/ensure", { method: "POST" }), browser);
  expect(result.status).toBe(503);
  expect(result.body).toContain("Missing Xvfb");
});
