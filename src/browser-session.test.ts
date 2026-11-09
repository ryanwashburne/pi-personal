import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserSession, isSnapStub } from "./browser-session";

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
    which: (name) => (name === "Xvfb" || name === "x11vnc" || name === "chromium" ? `/usr/bin/${name}` : null),
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
  expect(launched.map((entry) => entry.cmd)).toEqual(["/usr/bin/Xvfb", "/usr/bin/x11vnc", "/usr/bin/chromium"]);
  expect(launched[0].args).toContain("-ac");
  expect(launched[1].args).toContain("-xkb");
  const chrome = launched[2];
  expect(chrome.args.some((arg) => arg.startsWith(`--user-data-dir=${join(dir, "browser-profile")}`))).toBe(true);
  expect(chrome.args).toContain("--no-sandbox");
  expect(chrome.args).toContain("--remote-debugging-address=127.0.0.1");
  expect(chrome.args.some((arg) => arg.startsWith("file://") && arg.endsWith("home.html"))).toBe(true);

  await session.stop();
  expect(session.status().running).toBe(false);
});

test("start points Chromium at a Tailscale SOCKS proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-browser-"));
  const launched: Array<{ cmd: string; args: string[] }> = [];
  const session = createBrowserSession({
    agentCwd: dir,
    which: (name) => (name === "Xvfb" || name === "x11vnc" || name === "chromium" ? `/usr/bin/${name}` : null),
    spawn: (cmd, args) => {
      launched.push({ cmd, args: [...args] });
      return fakeChild();
    },
    waitForPort: async () => {},
    readyDelayMs: 0,
    async ensureNetwork() {
      return { proxyUrl: "socks5://127.0.0.1:1055", exitNode: "ryans-macbook" };
    },
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });
  await session.start();
  const chrome = launched.find((entry) => entry.cmd.endsWith("chromium"));
  expect(chrome?.args).toContain("--proxy-server=socks5://127.0.0.1:1055");
  expect(chrome?.args).toContain("--proxy-bypass-list=<-loopback>");
  expect(session.status().exitNode).toBe("ryans-macbook");
  await session.stop();
});

test("isSnapStub detects Ubuntu's chromium-browser wrapper", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-browser-"));
  const stub = join(dir, "chromium-browser");
  writeFileSync(
    stub,
    "#!/bin/sh\necho \"Command '$0' requires the chromium snap to be installed.\"\necho snap install chromium\nexit 1\n",
  );
  expect(isSnapStub(stub)).toBe(true);
  expect(isSnapStub("/opt/google/chrome/chrome")).toBe(false);

  const session = createBrowserSession({
    agentCwd: dir,
    which: (name) => {
      if (name === "Xvfb" || name === "x11vnc") return `/usr/bin/${name}`;
      if (name === "chromium" || name === "chromium-browser") return stub;
      return null;
    },
    spawn: () => fakeChild(),
    waitForPort: async () => {},
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });
  expect(session.status().missing).toEqual(["chromium"]);
  await expect(session.start()).rejects.toThrow(/snap wrapper/);
});

test("a failed start keeps the chromium error, not Xvfb SIGTERM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-browser-"));
  const listeners: Array<(code: number | null) => void> = [];
  function childWithExit(): ChildProcess {
    const child = {
      pid: 7,
      exitCode: null as number | null,
      stdout: { setEncoding() {}, on() {} },
      stderr: { setEncoding() {}, on() {} },
      on(_event: string, fn: (code: number | null) => void) {
        listeners.push(fn);
      },
      kill() {
        child.exitCode = 0;
        for (const fn of listeners) fn(0);
      },
    };
    return child as unknown as ChildProcess;
  }

  const session = createBrowserSession({
    agentCwd: dir,
    which: (name) => (name === "Xvfb" || name === "x11vnc" || name === "chromium" ? `/usr/bin/${name}` : null),
    spawn: () => childWithExit(),
    waitForPort: async (port) => {
      if (port === 9222) throw new Error("timed out waiting for 127.0.0.1:9222");
    },
    readyDelayMs: 0,
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });
  await expect(session.start()).rejects.toThrow("timed out waiting for 127.0.0.1:9222");
  expect(session.status().error ?? "").not.toMatch(/^Xvfb exited/);
});

test("start launches a window manager when openbox is installed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-browser-"));
  const launched: string[] = [];
  const session = createBrowserSession({
    agentCwd: dir,
    which: (name) =>
      name === "Xvfb" || name === "x11vnc" || name === "chromium" || name === "openbox" || name === "xsetroot"
        ? `/usr/bin/${name}`
        : null,
    spawn: (cmd) => {
      launched.push(cmd);
      return fakeChild();
    },
    waitForPort: async () => {},
    readyDelayMs: 0,
    async hold() {
      return { async heartbeat() {}, async release() {} };
    },
  });
  await session.start();
  expect(launched).toEqual([
    "/usr/bin/Xvfb",
    "/usr/bin/xsetroot",
    "/usr/bin/openbox",
    "/usr/bin/x11vnc",
    "/usr/bin/chromium",
  ]);
  await session.stop();
});
