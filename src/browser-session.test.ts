import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserSession } from "./browser-session";

function fakeChild(): ChildProcess {
  const child = {
    pid: 7,
    exitCode: null as number | null,
    stdout: { setEncoding() {}, on() {} },
    stderr: { setEncoding() {}, on() {} },
    on() {},
    kill() {
      child.exitCode = 0;
    },
  };
  return child as unknown as ChildProcess;
}

test("start fails when Xvfb, x11vnc, or chromium are missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-browser-"));
  const session = createBrowserSession({
    agentCwd: dir,
    which: () => null,
    spawn: () => fakeChild(),
    waitForPort: async () => {},
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });
  expect(session.status().missing).toEqual(["Xvfb", "x11vnc", "chromium"]);
  await expect(session.start()).rejects.toThrow("Missing");
});

test("start launches Xvfb, x11vnc, and chromium with a persistent profile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-browser-"));
  const launched: Array<{ cmd: string; args: string[] }> = [];
  const session = createBrowserSession({
    agentCwd: dir,
    which: (name) => `/usr/bin/${name}`,
    spawn: (cmd, args) => {
      launched.push({ cmd, args: [...args] });
      return fakeChild();
    },
    waitForPort: async () => {},
    readyDelayMs: 0,
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });

  await session.start();
  expect(session.status().running).toBe(true);
  expect(launched.map((entry) => entry.cmd)).toEqual(["Xvfb", "x11vnc", "/usr/bin/chromium"]);
  const chrome = launched[2];
  expect(chrome.args.some((arg) => arg.startsWith(`--user-data-dir=${join(dir, "browser-profile")}`))).toBe(true);
  expect(chrome.args).toContain("--no-sandbox");
  expect(chrome.args).toContain("--remote-debugging-address=127.0.0.1");

  await session.stop();
  expect(session.status().running).toBe(false);
});
