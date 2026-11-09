import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { waitForTcpPort } from "./browser-session";

export const TAILSCALE_SOCKS_PORT = 1055;

export type TailscaleStatus = {
  configured: boolean;
  running: boolean;
  hasAuthKey: boolean;
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
  sleep?: (ms: number) => Promise<void>;
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
  const sleep = options.sleep ?? delay;
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
      hasAuthKey: Boolean(options.authKey),
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
      await runTailscale(
        tailscale,
        [
          `--socket=${socket}`,
          "up",
          `--authkey=${options.authKey}`,
          "--accept-dns=false",
          `--hostname=${hostname}`,
        ],
        logs,
        "up",
      );
      const picked = await resolveExitNode(tailscale, socket, options.exitNode, logs, sleep);
      logs.push(`using exit node ${picked.name} at ${picked.ip}\n`);
      await runTailscale(
        tailscale,
        [`--socket=${socket}`, "set", `--exit-node=${picked.ip}`],
        logs,
        "set --exit-node",
      );
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
    const child = daemon;
    daemon = undefined;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await delay(400);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    stopping = false;
  }

  async function runTailscale(bin: string, args: string[], logs: string[], label: string): Promise<string> {
    const child = spawnChild(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const result = await waitForClose(child, 60_000);
    const mixed = `${result.stdout}${result.stderr}`;
    if (mixed) logs.push(mixed);
    if (result.code !== 0) {
      throw new Error(
        `tailscale ${label} failed (code=${result.code}).\n${redact(mixed.trim() || logs.join("").trim()) || "(no tailscale output)"}`,
      );
    }
    return result.stdout;
  }

  async function resolveExitNode(
    bin: string,
    sock: string,
    wanted: string,
    logs: string[],
    wait: (ms: number) => Promise<void>,
  ): Promise<{ ip: string; name: string }> {
    const deadline = Date.now() + 20_000;
    let lastError: Error | undefined;
    while (true) {
      try {
        const rawStatus = await runTailscale(bin, [`--socket=${sock}`, "status", "--json"], logs, "status");
        let parsed: TailscaleNetStatus;
        try {
          parsed = JSON.parse(rawStatus.trim() || "{}") as TailscaleNetStatus;
        } catch {
          throw new Error(`tailscale status --json was not JSON:\n${redact(rawStatus).slice(0, 1500)}`);
        }
        return pickExitNode(parsed, wanted);
      } catch (caught) {
        lastError = caught instanceof Error ? caught : new Error(String(caught));
        if (Date.now() >= deadline) throw lastError;
        logs.push(`waiting for exit node ${wanted}: ${lastError.message}\n`);
        await wait(1000);
      }
    }
  }

  return { status, start, stop };
}

export type TailscalePeer = {
  HostName?: string;
  DNSName?: string;
  Online?: boolean;
  ExitNodeOption?: boolean;
  TailscaleIPs?: string[];
};

export type TailscaleNetStatus = {
  Self?: TailscalePeer;
  Peer?: Record<string, TailscalePeer>;
};

export function pickExitNode(status: TailscaleNetStatus, wanted: string): { ip: string; name: string } {
  const want = normalizeNodeName(wanted);
  const peers = Object.values(status.Peer ?? {});
  const match = peers.find((peer) => namesOf(peer).some((name) => name === want || name.startsWith(`${want}.`)));
  if (!match) {
    const seen = peers
      .map((peer) => `${peer.HostName ?? "?"} online=${peer.Online ? "yes" : "no"} exit=${peer.ExitNodeOption ? "yes" : "no"}`)
      .join("\n");
    throw new Error(
      `No Tailscale peer matching ${wanted}. Seen:\n${seen || "(no peers — Sprite joined the tailnet but cannot see the Mac)"}`,
    );
  }
  const name = match.HostName ?? wanted;
  if (!match.Online) throw new Error(`${name} is offline. Wake the Mac and keep Tailscale connected.`);
  if (!match.ExitNodeOption) {
    throw new Error(`${name} is not an approved exit node. Enable it at https://login.tailscale.com/admin/machines`);
  }
  const ip = match.TailscaleIPs?.find((value) => value.startsWith("100.")) ?? match.TailscaleIPs?.[0];
  if (!ip) throw new Error(`${name} has no Tailscale IP.`);
  return { ip, name };
}

function namesOf(peer: TailscalePeer): string[] {
  return [peer.HostName, peer.DNSName, ...(peer.TailscaleIPs ?? [])]
    .filter((value): value is string => Boolean(value))
    .map(normalizeNodeName);
}

function normalizeNodeName(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, "");
}

function waitForClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("timed out waiting for tailscale"));
    }, timeoutMs);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: child.exitCode, stdout, stderr });
    };
    child.on("close", finish);
    child.on("exit", () => {
      queueMicrotask(finish);
    });
    if (child.exitCode !== null) queueMicrotask(finish);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
