import type { Config } from "./config";
import { HEARTBEAT_OK, isSilentHeartbeat } from "./heartbeat";
import { rejectForeignHome } from "./home-registration";
import { DEFAULT_HOME_DAEMON_PORT, homeDaemonPort, pushRoutineToHome, type SocksFetch } from "./home-push";
import { promptWithLiveView, syncLiveViewFile } from "./live-view";
import type { PiAgent } from "./pi";
import type { GatewayResult } from "./result";
import {
  loadRoutines,
  parseMode,
  parseRoutine,
  removeRoutine,
  saveRoutines,
  upsertRoutine,
  type Routine,
  type RoutineMode,
} from "./routine-store";
import { runScheduledTurn } from "./scheduled";
import type { SendblueClient } from "./sendblue";
import type { TailscaleService } from "./tailscale";
import type { Hold } from "./tasks";

export const ROUTINES_SESSION_ID = "routines";
export { DEFAULT_HOME_DAEMON_PORT, homeDaemonPort };

type SecretConfig = Pick<Config, "heartbeatPathSecret">;

export function routinePath(config: SecretConfig): string | undefined {
  const secret = config.heartbeatPathSecret?.trim();
  if (!secret) return undefined;
  return `/routine/${secret}`;
}

export function routinesCatalogPath(config: SecretConfig): string | undefined {
  const secret = config.heartbeatPathSecret?.trim();
  if (!secret) return undefined;
  return `/routines/${secret}`;
}

export function routinePrompt(
  input: { id: string; prompt: string; mode: RoutineMode },
  liveViewUrl: string | undefined,
): string {
  const modeNote =
    input.mode === "always"
      ? "This routine should text the owner unless there is truly nothing to say. If nothing should be texted, reply with exactly HEARTBEAT_OK."
      : "This routine is silent until something needs the owner. If nothing should be texted, reply with exactly HEARTBEAT_OK.";
  const body = [
    `This is scheduled routine ${input.id}, not a text from the owner. Follow ROUTINES.md.`,
    `Do this:`,
    "",
    input.prompt.trim(),
    "",
    `Write durable scratch to memory/routines/${input.id}.md so you do not re-text the same change.`,
    modeNote,
  ].join("\n");
  return promptWithLiveView(body, liveViewUrl);
}

export type RoutineFireOptions = {
  config: Pick<
    Config,
    "heartbeatPathSecret" | "allowedPhone" | "agentCwd" | "dashboardPathSecret" | "spriteUrl"
  >;
  pi: PiAgent;
  sendblue: SendblueClient;
  hold: () => Promise<Hold>;
  isBusy: () => boolean;
  setBusy: (busy: boolean) => void;
};

export async function handleRoutineFire(
  request: Request,
  options: RoutineFireOptions,
): Promise<GatewayResult | undefined> {
  const path = routinePath(options.config);
  if (!path) return undefined;
  const url = new URL(request.url);
  if (url.pathname !== path) return undefined;
  if (request.method !== "POST") {
    return { status: 405, body: "method not allowed" };
  }
  const blocked = await rejectForeignHome(request, options.config.agentCwd);
  if (blocked) return blocked;
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { status: 400, body: "invalid json" };
  }
  let parsed: { id: string; prompt: string; mode: RoutineMode };
  try {
    parsed = parseFireBody(payload);
  } catch (error) {
    return { status: 400, body: error instanceof Error ? error.message : String(error) };
  }
  if (options.isBusy()) {
    return { status: 200, body: "busy" };
  }
  options.setBusy(true);
  return {
    status: 200,
    body: "ok",
    work: async () => {
      const live = syncLiveViewFile(options.config, request.headers);
      await runScheduledTurn({
        label: `routine ${parsed.id}`,
        prompt: routinePrompt(parsed, live.liveViewUrl),
        pi: options.pi,
        sendblue: options.sendblue,
        to: options.config.allowedPhone,
        hold: options.hold,
        setBusy: options.setBusy,
        shouldDeliver: (text) => !isSilentHeartbeat(text),
      });
    },
  };
}

export async function handleRoutineCatalog(
  request: Request,
  options: { config: Pick<Config, "heartbeatPathSecret" | "agentCwd"> },
): Promise<GatewayResult | undefined> {
  const path = routinesCatalogPath(options.config);
  if (!path) return undefined;
  const url = new URL(request.url);
  if (url.pathname !== path) return undefined;
  if (request.method !== "GET") {
    return { status: 405, body: "method not allowed" };
  }
  const routines = await loadRoutines(options.config.agentCwd);
  return jsonResult(200, { routines });
}

export type RoutineAdminOptions = {
  config: Pick<Config, "agentCwd" | "heartbeatPathSecret"> & { homeDaemonPort?: number };
  tailscale?: TailscaleService;
  socksFetch?: SocksFetch;
  push?: (action: "upsert" | "delete", routine: Routine | { id: string }) => Promise<{ pushed: boolean; error?: string }>;
};

export async function handleRoutineAdmin(
  request: Request,
  options: RoutineAdminOptions,
): Promise<GatewayResult | undefined> {
  const url = new URL(request.url);
  if (url.pathname === "/routines") {
    if (request.method !== "GET") return { status: 405, body: "method not allowed" };
    const routines = await loadRoutines(options.config.agentCwd);
    return jsonResult(200, { routines });
  }
  const match = url.pathname.match(/^\/routines\/([a-z][a-z0-9-]{0,47})$/);
  if (!match) return undefined;
  const id = match[1];
  if (!id) return undefined;
  if (request.method === "PUT") {
    return upsertFromAdmin(request, options, id);
  }
  if (request.method === "DELETE") {
    return deleteFromAdmin(options, id);
  }
  return { status: 405, body: "method not allowed" };
}

async function upsertFromAdmin(
  request: Request,
  options: RoutineAdminOptions,
  id: string,
): Promise<GatewayResult> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { status: 400, body: "invalid json" };
  }
  let routine: Routine;
  try {
    routine = parseRoutine({ ...(payload as object), id });
  } catch (error) {
    return { status: 400, body: error instanceof Error ? error.message : String(error) };
  }
  const list = upsertRoutine(await loadRoutines(options.config.agentCwd), routine);
  await saveRoutines(options.config.agentCwd, list);
  const push = await pushChange(options, "upsert", routine);
  return jsonResult(200, { ok: true, routine, ...push, heartbeatOk: HEARTBEAT_OK });
}

async function deleteFromAdmin(options: RoutineAdminOptions, id: string): Promise<GatewayResult> {
  const existing = (await loadRoutines(options.config.agentCwd)).find((item) => item.id === id);
  const list = removeRoutine(await loadRoutines(options.config.agentCwd), id);
  await saveRoutines(options.config.agentCwd, list);
  const push = existing
    ? await pushChange(options, "delete", existing)
    : { pushed: false, error: "routine was not stored" };
  return jsonResult(200, { ok: true, id, removed: Boolean(existing), ...push });
}

async function pushChange(
  options: RoutineAdminOptions,
  action: "upsert" | "delete",
  routine: Routine,
): Promise<{ pushed: boolean; error?: string }> {
  if (options.push) {
    return options.push(action, action === "delete" ? { id: routine.id } : routine);
  }
  const secret = options.config.heartbeatPathSecret?.trim();
  if (!secret) {
    return { pushed: false, error: "HEARTBEAT_SECRET is not set." };
  }
  if (!options.tailscale) {
    return { pushed: false, error: "Tailscale is not configured." };
  }
  return pushRoutineToHome({
    action,
    id: routine.id,
    routine: action === "upsert" ? routine : undefined,
    secret,
    tailscale: options.tailscale,
    port: homeDaemonPort(options.config.homeDaemonPort),
    socksFetch: options.socksFetch,
  });
}

function parseFireBody(payload: unknown): { id: string; prompt: string; mode: RoutineMode } {
  if (!payload || typeof payload !== "object") {
    throw new Error("routine body must be JSON.");
  }
  const value = payload as Record<string, unknown>;
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required.");
  const idRaw = typeof value.id === "string" && value.id.trim() ? value.id.trim().toLowerCase() : "adhoc";
  const id = idRaw.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "adhoc";
  return { id, prompt, mode: parseMode(value.mode) };
}

function jsonResult(status: number, body: unknown): GatewayResult {
  return {
    status,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  };
}
