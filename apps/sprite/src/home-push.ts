import type { Routine } from "./routine-store";
import type { TailscaleService } from "./tailscale";

export const DEFAULT_HOME_DAEMON_PORT = 8787;

export type SocksFetch = (options: {
  url: string;
  socksHost: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutSec?: number;
}) => Promise<{ status: number; body: string }>;

export type HomePushResult = {
  pushed: boolean;
  error?: string;
};

export function homeDaemonPort(value?: number): number {
  return value && value > 0 ? value : DEFAULT_HOME_DAEMON_PORT;
}

export function socksHostFromUrl(socksUrl: string | undefined): string | undefined {
  if (!socksUrl) return undefined;
  try {
    const parsed = new URL(socksUrl);
    if (!parsed.hostname || !parsed.port) return undefined;
    return `${parsed.hostname}:${parsed.port}`;
  } catch {
    return undefined;
  }
}

export async function pushRoutineToHome(options: {
  action: "upsert" | "delete";
  id: string;
  routine?: Routine;
  secret: string;
  tailscale: TailscaleService;
  port?: number;
  socksFetch?: SocksFetch;
}): Promise<HomePushResult> {
  try {
    await options.tailscale.start();
  } catch (error) {
    return { pushed: false, error: error instanceof Error ? error.message : String(error) };
  }
  const status = options.tailscale.status();
  const ip = status.exitNodeIp;
  const socksHost = socksHostFromUrl(status.socksUrl);
  if (!status.running || !ip || !socksHost) {
    return { pushed: false, error: "Tailscale exit node is not up." };
  }
  const fetchFn = options.socksFetch ?? curlSocksFetch;
  const port = homeDaemonPort(options.port);
  const url = `http://${ip}:${port}/routines/${encodeURIComponent(options.id)}`;
  try {
    const response = await fetchFn({
      url,
      socksHost,
      method: options.action === "delete" ? "DELETE" : "PUT",
      headers: {
        authorization: `Bearer ${options.secret}`,
        "content-type": "application/json",
      },
      body: options.action === "delete" ? undefined : JSON.stringify(options.routine),
      timeoutSec: 15,
    });
    if (response.status < 200 || response.status >= 300) {
      return { pushed: false, error: `home daemon HTTP ${response.status}` };
    }
    return { pushed: true };
  } catch (error) {
    return { pushed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function curlSocksFetch(options: {
  url: string;
  socksHost: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutSec?: number;
}): Promise<{ status: number; body: string }> {
  const args = [
    "-sS",
    "-o",
    "-",
    "-w",
    "\n%{http_code}",
    "--max-time",
    String(options.timeoutSec ?? 15),
    "--socks5-hostname",
    options.socksHost,
    "-X",
    options.method,
  ];
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    args.push("-H", `${name}: ${value}`);
  }
  if (options.body !== undefined) {
    args.push("--data-binary", options.body);
  }
  args.push(options.url);
  const proc = Bun.spawn(["curl", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(stderr.trim() || `curl exited ${code}`);
  }
  const trimmed = stdout.replace(/\n$/, "");
  const split = trimmed.lastIndexOf("\n");
  const body = split === -1 ? "" : trimmed.slice(0, split);
  const statusRaw = split === -1 ? trimmed : trimmed.slice(split + 1);
  const status = Number(statusRaw);
  if (!Number.isInteger(status)) {
    throw new Error("curl did not return an HTTP status.");
  }
  return { status, body };
}
