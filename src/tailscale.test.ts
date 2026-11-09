import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTailscale } from "./tailscale";

function fakeChild(exitImmediately?: number): ChildProcess {
  const child = {
    pid: 3,
    exitCode: exitImmediately === undefined ? (null as number | null) : exitImmediately,
    stdout: { setEncoding() {}, on() {} },
    stderr: { setEncoding() {}, on() {} },
    on(event: string, fn: (code: number | null) => void) {
      if (event === "exit" && child.exitCode !== null) queueMicrotask(() => fn(child.exitCode));
    },
    kill() {
      child.exitCode = 0;
    },
  };
  return child as unknown as ChildProcess;
}

test("start is a no-op without Tailscale env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ts-"));
  const session = createTailscale({
    stateDir: dir,
    spawn: () => fakeChild(),
    which: () => "/usr/sbin/tailscaled",
    waitForPort: async () => {},
  });
  await session.start();
  expect(session.status().configured).toBe(false);
  expect(session.status().running).toBe(false);
});

test("start requires both auth key and exit node", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ts-"));
  const session = createTailscale({
    stateDir: dir,
    authKey: "tskey-auth-test",
    spawn: () => fakeChild(),
    which: () => "/usr/sbin/tailscaled",
    waitForPort: async () => {},
  });
  await expect(session.start()).rejects.toThrow("TAILSCALE_EXIT_NODE");
});

test("start launches userspace tailscaled and up with the exit node", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ts-"));
  const launched: Array<{ cmd: string; args: string[] }> = [];
  const session = createTailscale({
    stateDir: dir,
    authKey: "tskey-auth-test",
    exitNode: "ryans-macbook",
    spawn: (cmd, args) => {
      launched.push({ cmd, args: [...args] });
      if (args.includes("up")) return fakeChild(0);
      return fakeChild();
    },
    which: (name) => `/usr/sbin/${name}`,
    waitForPort: async () => {},
  });
  await session.start();
  expect(session.status().running).toBe(true);
  expect(session.status().socksUrl).toBe("socks5://127.0.0.1:1055");
  expect(launched[0].cmd).toBe("/usr/sbin/tailscaled");
  expect(launched[0].args).toContain("--tun=userspace-networking");
  expect(launched[0].args).toContain("--socks5-server=127.0.0.1:1055");
  expect(launched[1].args).toContain("--exit-node=ryans-macbook");
  expect(launched[1].args).toContain("--accept-dns=false");
  expect(launched[1].args.some((arg) => arg === "--reset")).toBe(false);
  await session.stop();
  expect(session.status().running).toBe(false);
});

test("a failed up includes tailscale stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ts-"));
  const session = createTailscale({
    stateDir: dir,
    authKey: "tskey-auth-test",
    exitNode: "missing-node",
    spawn: (_cmd, args) => {
      if (!args.includes("up")) return fakeChild();
      const exitListeners: Array<(code: number | null) => void> = [];
      const child = {
        pid: 3,
        exitCode: null as number | null,
        stdout: { setEncoding() {}, on() {} },
        stderr: {
          setEncoding() {},
          on(event: string, fn: (chunk: string) => void) {
            if (event === "data") {
              queueMicrotask(() => {
                fn("no node named missing-node\n");
                child.exitCode = 1;
                for (const listener of exitListeners) listener(1);
              });
            }
          },
        },
        on(event: string, fn: (code: number | null) => void) {
          if (event === "exit") exitListeners.push(fn);
        },
        kill() {},
      };
      return child as unknown as ChildProcess;
    },
    which: (name) => `/usr/sbin/${name}`,
    waitForPort: async () => {},
  });
  await expect(session.start()).rejects.toThrow(/no node named missing-node/);
});
