export const ROUTINE_ACTIONS = ["list", "upsert", "remove"] as const;
export type RoutineAction = (typeof ROUTINE_ACTIONS)[number];
export type RoutineMode = "always" | "silent";

export type RoutineToolParams = {
  action?: string;
  id?: string;
  title?: string;
  cron?: string;
  timezone?: string;
  prompt?: string;
  mode?: string;
  enabled?: boolean;
};

export type RoutineFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type RoutineToolDeps = {
  env?: NodeJS.ProcessEnv;
  fetchFn?: RoutineFetch;
};

export function parseRoutineAction(value: string | undefined): RoutineAction {
  const action = (value ?? "list").trim().toLowerCase();
  for (const allowed of ROUTINE_ACTIONS) {
    if (allowed === action) return allowed;
  }
  throw new Error(`Unknown action: ${value ?? ""}. Use ${ROUTINE_ACTIONS.join(", ")}.`);
}

export function internalRoutinesUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = env.INTERNAL_PORT?.trim() || "8081";
  return `http://127.0.0.1:${port}/routines`;
}

export async function runRoutineTool(
  params: RoutineToolParams,
  deps: RoutineToolDeps = {},
): Promise<string> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const action = parseRoutineAction(params.action);
  const base = internalRoutinesUrl(env);
  switch (action) {
    case "list":
      return await call(fetchFn, base, "GET");
    case "upsert": {
      const id = requiredId(params.id);
      return await call(fetchFn, `${base}/${id}`, "PUT", {
        id,
        title: params.title,
        cron: params.cron,
        timezone: params.timezone,
        prompt: params.prompt,
        mode: params.mode,
        enabled: params.enabled,
      });
    }
    case "remove": {
      const id = requiredId(params.id);
      return await call(fetchFn, `${base}/${id}`, "DELETE");
    }
    default: {
      const _never: never = action;
      throw new Error(`unexpected routine action ${JSON.stringify(_never)}`);
    }
  }
}

function requiredId(value: string | undefined): string {
  const id = value?.trim().toLowerCase() ?? "";
  if (!id) throw new Error("id is required.");
  return id;
}

async function call(
  fetchFn: RoutineFetch,
  url: string,
  method: string,
  body?: unknown,
): Promise<string> {
  const response = await fetchFn(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text.trim() || `HTTP ${response.status}`);
  }
  return text;
}
