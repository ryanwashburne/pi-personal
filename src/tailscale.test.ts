import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTailscale, pickExitNode } from "./tailscale";

const macPeer = {
  HostName: "ryans-macbook",
  DNSName: "ryans-macbook.tail.ts.net.",
  Online: true,
  ExitNodeOption: true,
  TailscaleIPs: ["100.64.1.1"],
};

function fakeOutput(code: number, output: string): ChildProcess {
  const exitListeners: Array<(code: number | null) => void> = [];
  const closeListeners: Array<() => void> = [];
  const child = {
    pid: 3,
    exitCode: null as number | null,
    stdout: {
      setEncoding() {},
      on(event: string, fn: (chunk: string) => void) {
        if (event === "data") {
          queueMicrotask(() => {
            fn(output);
            child.exitCode = code;
            for (const listener of exitListeners) listener(code);
            for (const listener of closeListeners) listener();
          });
        }
      },
    },
    stderr: { setEncoding() {}, on() {} },
    on(event: string, fn: (code?: number | null) => void) {
      if (event === "exit") exitListeners.push(fn);
      if (event === "close") closeListeners.push(() => fn());
    },
    kill() {},
  };
  return child as unknown as ChildProcess;
}

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

test("stop is safe when tailscaled never started", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ts-"));
  const session = createTailscale({
    stateDir: dir,
    spawn: () => fakeChild(),
    which: () => "/usr/sbin/tailscaled",
    waitForPort: async () => {},
  });
  await session.stop();
  await session.stop();
  expect(session.status().running).toBe(false);
});

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
      if (args.includes("status")) return fakeOutput(0, JSON.stringify({ Peer: { n: macPeer } }));
      if (args.includes("up") || args.includes("set")) return fakeChild(0);
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
  expect(launched[1].args).toContain("up");
  expect(launched[1].args).toContain("--accept-dns=false");
  expect(launched[1].args.some((arg) => arg.startsWith("--exit-node="))).toBe(false);
  expect(launched[2].args).toContain("status");
  expect(launched[3].args).toContain("set");
  expect(launched[3].args).toContain("--exit-node=100.64.1.1");
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

test("pickExitNode matches hostname or MagicDNS and requires an approved online node", () => {
  const status = { Peer: { n: macPeer } };
  expect(pickExitNode(status, "ryans-macbook").ip).toBe("100.64.1.1");
  expect(pickExitNode(status, "ryans-macbook.tail.ts.net").ip).toBe("100.64.1.1");
  expect(pickExitNode(status, "100.64.1.1").ip).toBe("100.64.1.1");
  expect(
    pickExitNode(
      { Peer: { n: { ...macPeer, TailscaleIPs: ["fd7a:115c:a1e0::1", "100.64.1.1"] } } },
      "ryans-macbook",
    ).ip,
  ).toBe("100.64.1.1");
  expect(() => pickExitNode(status, "other-mac")).toThrow(/No Tailscale peer matching/);
  expect(() => pickExitNode({ Peer: { n: { ...macPeer, Online: false } } }, "ryans-macbook")).toThrow(/offline/);
  expect(() => pickExitNode({ Peer: { n: { ...macPeer, ExitNodeOption: false } } }, "ryans-macbook")).toThrow(
    /not an approved exit node/,
  );
});

test("start retries status until the Mac appears as a peer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ts-"));
  let statusCalls = 0;
  const launched: Array<string[]> = [];
  const session = createTailscale({
    stateDir: dir,
    authKey: "tskey-auth-test",
    exitNode: "ryans-macbook",
    sleep: async () => {},
    spawn: (_cmd, args) => {
      launched.push([...args]);
      if (args.includes("status")) {
        statusCalls += 1;
        if (statusCalls === 1) return fakeOutput(0, JSON.stringify({ Peer: {} }));
        return fakeOutput(0, JSON.stringify({ Peer: { n: macPeer } }));
      }
      if (args.includes("up") || args.includes("set")) return fakeChild(0);
      return fakeChild();
    },
    which: (name) => `/usr/sbin/${name}`,
    waitForPort: async () => {},
  });
  await session.start();
  expect(statusCalls).toBe(2);
  expect(launched.some((args) => args.includes("--exit-node=100.64.1.1"))).toBe(true);
  await session.stop();
});
