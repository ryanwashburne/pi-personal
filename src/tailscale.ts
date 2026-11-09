import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { waitForTcpPort } from "./browser-session";

export const TAILSCALE_SOCKS_PORT = 1055;

export type TailscaleStatus = {
  configured: boolean;
  running: boolean;
  exitNode?: string;
  socksUrl?: string;
  error?: string;
};

type SpawnFn = (command: string, args: string[], options?: Parameters<typeof spawn>[2]) => ChildProcess;
type WhichFn = (name: string) => string | null;

export type TailscaleOptions = {
  stateDir: string;
  authKey?: string;
  exitNode?: string;
  socksPort?: number;
  hostname?: string;
  spawn?: SpawnFn;
  which?: WhichFn;
  waitForPort?: (port: number, timeoutMs: number) => Promise<void>;
};

export type TailscaleService = {
  status: () => TailscaleStatus;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export function createTailscale(options: TailscaleOptions): TailscaleService {
  const socksPort = options.socksPort ?? TAILSCALE_SOCKS_PORT;
  const spawnChild = options.spawn ?? spawn;
  const which = options.which ?? ((name: string) => Bun.which(name) ?? null);
  const waitForPort = options.waitForPort ?? waitForTcpPort;
  const socket = join(options.stateDir, "tailscaled.sock");
  const hostname = options.hostname ?? "pi-personal";

  let running = false;
  let stopping = false;
  let error: string | undefined;
  let daemon: ChildProcess | undefined;

  function configured(): boolean {
    return Boolean(options.authKey && options.exitNode);
  }

  function status(): TailscaleStatus {
    return {
      configured: configured(),
      running,
      exitNode: options.exitNode,
      socksUrl: running ? `socks5://127.0.0.1:${socksPort}` : undefined,
      error,
    };
  }

  async function start() {
    if (running) return;
    if (!options.authKey && !options.exitNode) return;
    if (!options.authKey || !options.exitNode) {
      error = "Set both TAILSCALE_AUTHKEY and TAILSCALE_EXIT_NODE (MacBook now, rpi later).";
      throw new Error(error);
    }

    const tailscaled = which("tailscaled");
    const tailscale = which("tailscale");
    if (!tailscaled || !tailscale) {
      error = "tailscale is not installed. Re-run ./scripts/provision.sh.";
      throw new Error(error);
    }

    mkdirSync(options.stateDir, { recursive: true });
    error = undefined;

    const logs: string[] = [];
    daemon = collectLogs(
      spawnChild(
        tailscaled,
        [
          `--statedir=${options.stateDir}`,
          `--socket=${socket}`,
          "--tun=userspace-networking",
          `--socks5-server=127.0.0.1:${socksPort}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
      logs,
    );
    daemon.on("exit", (code) => {
      if (stopping) return;
      running = false;
      error = `tailscaled exited (code=${code})`;
    });

    try {
      await waitForPort(socksPort, 15_000);
      const up = collectLogs(
        spawnChild(
          tailscale,
          [
            `--socket=${socket}`,
            "up",
            `--authkey=${options.authKey}`,
            `--exit-node=${options.exitNode}`,
            "--accept-dns=false",
            `--hostname=${hostname}`,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
        logs,
      );
      const code = await waitForExit(up, 60_000);
      if (code !== 0) {
        throw new Error(
          `tailscale up failed (code=${code}). Mac awake? Exit node approved? Name matches TAILSCALE_EXIT_NODE?\n${redact(logs.join("").trim()) || "(no tailscale output)"}`,
        );
      }
      running = true;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      const extra = redact(logs.join("").trim());
      if (extra && !error.includes(extra)) error = `${error}\n${extra}`;
      await stop();
      throw new Error(error);
    }
  }

  async function stop() {
    stopping = true;
    running = false;
    if (daemon && daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await delay(400);
      if (daemon.exitCode === null) daemon.kill("SIGKILL");
    }
    daemon = undefined;
    stopping = false;
  }

  return { status, start, stop };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("timed out waiting for tailscale up"));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function collectLogs(child: ChildProcess, logs: string[]): ChildProcess {
  const append = (chunk: string) => {
    logs.push(chunk);
    if (logs.join("").length > 8_000) logs.splice(0, logs.length - 4);
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => append(chunk));
  child.stderr?.on("data", (chunk: string) => append(chunk));
  return child;
}

function redact(text: string): string {
  return text.replace(/tskey-[a-z0-9-]+/gi, "tskey-REDACTED");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
