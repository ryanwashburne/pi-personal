export type SpendFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type VendorStatus =
  | { ok: true; vendor: string; [key: string]: unknown }
  | { ok: false; vendor: string; error: string };

const TIMEOUT_MS = 10_000;

export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function redactPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const last4 = digits.slice(-4) || "????";
  return `+…${last4}`;
}

export async function sendblueSpend(
  env: NodeJS.ProcessEnv,
  fetchFn: SpendFetch,
): Promise<VendorStatus> {
  const keyId = envValue(env, "SENDBLUE_API_KEY_ID");
  const keySecret = envValue(env, "SENDBLUE_API_KEY_SECRET");
  if (!keyId || !keySecret) {
    return { ok: false, vendor: "sendblue", error: "SENDBLUE_API_KEY_ID / SENDBLUE_API_KEY_SECRET are not set." };
  }

  const response = await request(
    fetchFn,
    "https://api.sendblue.com/api/v2/lines/usage",
    {
      headers: {
        "sb-api-key-id": keyId,
        "sb-api-secret-key": keySecret,
        Accept: "application/json",
        "User-Agent": "pi-personal/1.0",
      },
    },
  );
  if (!response.ok) return { ...response, vendor: "sendblue" };

  const body = response.body as {
    enabled?: boolean;
    lines?: Array<{
      phone?: string;
      state?: string;
      daily?: { used?: number | null; limit?: number | null; remaining?: number | null };
      hourly?: { used?: number | null; limit?: number | null; remaining?: number | null };
    }>;
  };
  const lines = (body.lines ?? []).map((line) => ({
    phone: redactPhone(line.phone ?? ""),
    state: line.state ?? "unknown",
    daily: line.daily ?? null,
    hourly: line.hourly ?? null,
  }));

  return {
    ok: true,
    vendor: "sendblue",
    enabled: body.enabled !== false,
    lineCount: lines.length,
    publishedUsdPerLine: 100,
    publishedMonthlyUsd: lines.length * 100,
    note: "Sendblue bills a flat $100/line on the AI Agent plan. The usage numbers are new-contact capacity, not dollars. Phones are last-4 only.",
    lines,
  };
}

export async function openrouterSpend(
  env: NodeJS.ProcessEnv,
  fetchFn: SpendFetch,
): Promise<VendorStatus> {
  const key = envValue(env, "OPENROUTER_API_KEY");
  if (!key) {
    return { ok: false, vendor: "openrouter", error: "OPENROUTER_API_KEY is not set." };
  }

  const response = await request(fetchFn, "https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!response.ok) return { ...response, vendor: "openrouter" };

  const data = (response.body as { data?: Record<string, unknown> }).data ?? {};
  return {
    ok: true,
    vendor: "openrouter",
    usageUsd: numberOrNull(data.usage),
    usageDailyUsd: numberOrNull(data.usage_daily),
    usageWeeklyUsd: numberOrNull(data.usage_weekly),
    usageMonthlyUsd: numberOrNull(data.usage_monthly),
    limitUsd: numberOrNull(data.limit),
    limitRemainingUsd: numberOrNull(data.limit_remaining),
    limitReset: typeof data.limit_reset === "string" ? data.limit_reset : null,
    note: "This OpenRouter key’s usage. Lifetime credits need a management key (GET /credits) and are not queried here.",
  };
}

export async function anthropicOrgSpend(
  env: NodeJS.ProcessEnv,
  fetchFn: SpendFetch,
  now: Date,
): Promise<VendorStatus> {
  const key = envValue(env, "ANTHROPIC_ADMIN_API_KEY") ?? envValue(env, "ANTHROPIC_API_KEY");
  if (!key) {
    return {
      ok: false,
      vendor: "anthropic",
      error:
        "No ANTHROPIC_ADMIN_API_KEY or ANTHROPIC_API_KEY in env. Org cost_report needs an Admin key (sk-ant-admin01-…) or an unscoped personal key. This agent’s own tokens are in the model section from session files.",
    };
  }

  const startingAt = utcMonthStartIso(now);
  const endingAt = now.toISOString();
  const url =
    "https://api.anthropic.com/v1/organizations/cost_report" +
    `?starting_at=${encodeURIComponent(startingAt)}` +
    `&ending_at=${encodeURIComponent(endingAt)}` +
    "&bucket_width=1d&group_by[]=description&limit=31";

  const response = await request(fetchFn, url, {
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      Accept: "application/json",
      "User-Agent": "pi-personal/1.0",
    },
  });
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? " Workspace API keys cannot read cost_report. Set ANTHROPIC_ADMIN_API_KEY to an Admin key."
        : "";
    return { ok: false, vendor: "anthropic", error: `${response.error}${hint}` };
  }

  const body = response.body as {
    data?: Array<{
      starting_at?: string;
      ending_at?: string;
      results?: Array<{ amount?: string; currency?: string; model?: string | null; cost_type?: string | null }>;
    }>;
  };
  const byModel = new Map<string, number>();
  let usd = 0;
  for (const bucket of body.data ?? []) {
    for (const item of bucket.results ?? []) {
      const amount = centsToUsd(item.amount);
      usd += amount;
      const label = item.model || item.cost_type || "other";
      byModel.set(label, (byModel.get(label) ?? 0) + amount);
    }
  }

  return {
    ok: true,
    vendor: "anthropic",
    periodStart: startingAt,
    periodEnd: endingAt,
    period: "UTC calendar month to now",
    usd,
    byModel: [...byModel.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([model, amount]) => ({ model, usd: amount })),
    note: "Anthropic org cost_report. Includes every key in the org, not just this Sprite. Amounts converted from cents.",
  };
}

export function flySpend(): VendorStatus {
  return {
    ok: false,
    vendor: "fly",
    error:
      "Fly has no public billing API for Sprites. Compute is billed while this box is awake; cold disk still bills at ~$0.02/GB-month. See COST.md. This request is holding the Sprite running.",
  };
}

export function utcMonthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function centsToUsd(amount: string | undefined): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function request(
  fetchFn: SpendFetch,
  url: string,
  init: RequestInit,
): Promise<{ ok: true; body: unknown } | { ok: false; vendor: string; error: string; status?: number }> {
  try {
    const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        vendor: "http",
        status: response.status,
        error: `HTTP ${response.status} ${truncate(text, 300)}`.trim(),
      };
    }
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, vendor: "http", error: "Vendor returned non-JSON." };
    }
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      vendor: "http",
      error: timedOut ? `Timed out after ${TIMEOUT_MS}ms` : error instanceof Error ? error.message : "Request failed",
    };
  }
}

function truncate(text: string, max: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}
