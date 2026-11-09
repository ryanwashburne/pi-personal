import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config";
import type { GatewayResult } from "./result";
import type { TailscaleService } from "./tailscale";

export const HOME_NODE_HEADER = "x-home-node";
export const UNREGISTERED_HOME_BODY = "youAreRegistered: false";

export type HomeRegistration = {
  nodeId: string;
  hostname: string;
  registeredAt: string;
};

type SecretConfig = Pick<Config, "heartbeatPathSecret">;

const NODE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const HOSTNAME_RE = /^[A-Za-z0-9._-]{1,253}$/;

export function homeRegistrationPath(agentCwd: string): string {
  return join(agentCwd, "memory", "home.json");
}

export function homePath(config: SecretConfig): string | undefined {
  const secret = config.heartbeatPathSecret?.trim();
  if (!secret) return undefined;
  return `/home/${secret}`;
}

export function registeredHostname(agentCwd: string): string | undefined {
  return readHomeRegistrationSync(agentCwd)?.hostname;
}

export function registeredNodeId(agentCwd: string): string | undefined {
  return readHomeRegistrationSync(agentCwd)?.nodeId;
}

export function effectiveExitNode(agentCwd: string, fallback?: string): string | undefined {
  return registeredHostname(agentCwd) ?? emptyToUndefined(fallback);
}

export function homeNodeFromRequest(request: Request): string | undefined {
  return emptyToUndefined(request.headers.get(HOME_NODE_HEADER));
}

export async function loadHomeRegistration(agentCwd: string): Promise<HomeRegistration | undefined> {
  try {
    return parseRegistration(await readFile(homeRegistrationPath(agentCwd), "utf8"));
  } catch {
    return undefined;
  }
}

export async function saveHomeRegistration(agentCwd: string, registration: HomeRegistration): Promise<void> {
  const path = homeRegistrationPath(agentCwd);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function rejectForeignHome(
  request: Request,
  agentCwd: string,
): Promise<GatewayResult | undefined> {
  const registration = await loadHomeRegistration(agentCwd);
  if (!registration) return undefined;
  const nodeId = homeNodeFromRequest(request);
  if (nodeId && nodeId === registration.nodeId) return undefined;
  return { status: 409, body: UNREGISTERED_HOME_BODY };
}

export type HomeRegisterOptions = {
  config: Pick<Config, "heartbeatPathSecret" | "agentCwd">;
  tailscale?: TailscaleService;
  now?: () => Date;
};

export async function handleHomeRegister(
  request: Request,
  options: HomeRegisterOptions,
): Promise<GatewayResult | undefined> {
  const path = homePath(options.config);
  if (!path) return undefined;
  const url = new URL(request.url);
  if (url.pathname !== path) return undefined;
  if (request.method !== "POST") {
    return { status: 405, body: "method not allowed" };
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { status: 400, body: "invalid json" };
  }
  let parsed: { nodeId: string; hostname: string };
  try {
    parsed = parseRegisterBody(payload);
  } catch (error) {
    return { status: 400, body: error instanceof Error ? error.message : String(error) };
  }
  const registration: HomeRegistration = {
    nodeId: parsed.nodeId,
    hostname: parsed.hostname,
    registeredAt: (options.now?.() ?? new Date()).toISOString(),
  };
  await saveHomeRegistration(options.config.agentCwd, registration);
  if (options.tailscale) {
    try {
      await options.tailscale.stop();
      await options.tailscale.start();
    } catch (error) {
      console.warn("tailscale restart after home register failed", error);
    }
  }
  return jsonResult(200, {
    ok: true,
    hostname: registration.hostname,
    nodeId: registration.nodeId,
  });
}

export function parseRegisterBody(payload: unknown): { nodeId: string; hostname: string } {
  if (!payload || typeof payload !== "object") {
    throw new Error("body must be a JSON object");
  }
  const record = payload as Record<string, unknown>;
  const nodeId = typeof record.nodeId === "string" ? record.nodeId.trim() : "";
  const hostname = typeof record.hostname === "string" ? record.hostname.trim() : "";
  if (!NODE_ID_RE.test(nodeId)) throw new Error("nodeId is invalid");
  if (!HOSTNAME_RE.test(hostname)) throw new Error("hostname is invalid");
  return { nodeId, hostname };
}

function readHomeRegistrationSync(agentCwd: string): HomeRegistration | undefined {
  const path = homeRegistrationPath(agentCwd);
  if (!existsSync(path)) return undefined;
  try {
    return parseRegistration(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function parseRegistration(raw: string): HomeRegistration | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const nodeId = typeof record.nodeId === "string" ? record.nodeId.trim() : "";
  const hostname = typeof record.hostname === "string" ? record.hostname.trim() : "";
  const registeredAt = typeof record.registeredAt === "string" ? record.registeredAt.trim() : "";
  if (!NODE_ID_RE.test(nodeId) || !HOSTNAME_RE.test(hostname)) return undefined;
  return { nodeId, hostname, registeredAt: registeredAt || new Date(0).toISOString() };
}

function jsonResult(status: number, payload: unknown): GatewayResult {
  return {
    status,
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  };
}

function emptyToUndefined(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
