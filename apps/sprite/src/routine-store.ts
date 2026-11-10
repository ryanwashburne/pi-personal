import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_TIMEZONE, validateCron } from "./cron";

export const ROUTINE_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;

export type RoutineMode = "always" | "silent";

export type Routine = {
  id: string;
  title: string;
  cron: string;
  timezone: string;
  prompt: string;
  mode: RoutineMode;
  enabled: boolean;
};

type RoutineFile = {
  routines?: unknown;
};

export function routinesFilePath(agentCwd: string): string {
  return join(agentCwd, "memory", "routines.json");
}

export function routineScratchPath(agentCwd: string, id: string): string {
  return join(agentCwd, "memory", "routines", `${id}.md`);
}

export async function loadRoutines(agentCwd: string): Promise<Routine[]> {
  const path = routinesFilePath(agentCwd);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  let parsed: RoutineFile;
  try {
    parsed = JSON.parse(raw) as RoutineFile;
  } catch {
    throw new Error("routines.json is not valid JSON.");
  }
  if (!Array.isArray(parsed.routines)) return [];
  return parsed.routines.map((entry, index) => parseRoutine(entry, `routines[${index}]`));
}

export async function saveRoutines(agentCwd: string, routines: Routine[]): Promise<void> {
  const path = routinesFilePath(agentCwd);
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify({ routines }, null, 2)}\n`;
  await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
}

export function upsertRoutine(list: Routine[], routine: Routine): Routine[] {
  const next = list.filter((item) => item.id !== routine.id);
  next.push(routine);
  next.sort((a, b) => a.id.localeCompare(b.id));
  return next;
}

export function removeRoutine(list: Routine[], id: string): Routine[] {
  return list.filter((item) => item.id !== id);
}

export function parseRoutine(input: unknown, label = "routine"): Routine {
  if (!input || typeof input !== "object") {
    throw new Error(`${label} must be an object.`);
  }
  const value = input as Record<string, unknown>;
  const id = requiredString(value.id, `${label}.id`).toLowerCase();
  if (!ROUTINE_ID_RE.test(id)) {
    throw new Error(`${label}.id must match ${ROUTINE_ID_RE}.`);
  }
  const prompt = requiredString(value.prompt, `${label}.prompt`);
  const cron = requiredString(value.cron, `${label}.cron`);
  const cronError = validateCron(cron);
  if (cronError) throw new Error(`${label}.cron: ${cronError}`);
  const mode = parseMode(value.mode, `${label}.mode`);
  const timezone = optionalString(value.timezone) || DEFAULT_TIMEZONE;
  if (timezone.includes("\n") || timezone.includes("\r")) {
    throw new Error(`${label}.timezone is invalid.`);
  }
  const title = optionalString(value.title) || id;
  const enabled = value.enabled === undefined ? true : Boolean(value.enabled);
  return { id, title, cron, timezone, prompt, mode, enabled };
}

export function parseMode(value: unknown, label = "mode"): RoutineMode {
  if (value === undefined || value === "") return "silent";
  if (value === "always" || value === "silent") return value;
  throw new Error(`${label} must be always or silent.`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
