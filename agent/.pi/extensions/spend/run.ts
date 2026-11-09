import { defaultSessionDir, readSessionTexts, summarizeSessionTexts, type SessionSpend } from "./session";
import {
  anthropicOrgSpend,
  flySpend,
  openrouterSpend,
  sendblueSpend,
  type SpendFetch,
  type VendorStatus,
} from "./vendors";

export const SPEND_VENDORS = ["all", "model", "sendblue", "openrouter", "anthropic", "fly"] as const;
export type SpendVendor = (typeof SPEND_VENDORS)[number];

export type SpendDeps = {
  env?: NodeJS.ProcessEnv;
  fetchFn?: SpendFetch;
  now?: Date;
  cwd?: string;
  sessionTexts?: string[];
};

export type SpendReport = {
  generatedAt: string;
  vendor: SpendVendor;
  summary: string;
  model?: SessionSpend;
  sendblue?: VendorStatus;
  openrouter?: VendorStatus;
  anthropic?: VendorStatus;
  fly?: VendorStatus;
};

export function parseSpendVendor(value: string | undefined): SpendVendor {
  const vendor = (value ?? "all").trim().toLowerCase();
  for (const allowed of SPEND_VENDORS) {
    if (allowed === vendor) return allowed;
  }
  throw new Error(`Unknown vendor: ${value ?? ""}. Use ${SPEND_VENDORS.join(", ")}.`);
}

export async function runSpend(vendor: SpendVendor, deps: SpendDeps = {}): Promise<SpendReport> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? new Date();
  const cwd = deps.cwd ?? process.cwd();
  const include = (name: Exclude<SpendVendor, "all">) => vendor === "all" || vendor === name;

  const report: SpendReport = {
    generatedAt: now.toISOString(),
    vendor,
    summary: "",
  };

  if (include("model")) {
    const texts = deps.sessionTexts ?? readSessionTexts(defaultSessionDir(env, cwd));
    report.model = summarizeSessionTexts(texts);
  }
  if (include("sendblue")) report.sendblue = await sendblueSpend(env, fetchFn);
  if (include("openrouter")) report.openrouter = await openrouterSpend(env, fetchFn);
  if (include("anthropic")) report.anthropic = await anthropicOrgSpend(env, fetchFn, now);
  if (include("fly")) report.fly = flySpend();

  report.summary = summarize(report);
  return report;
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function summarize(report: SpendReport): string {
  const parts: string[] = [];
  if (report.model) {
    const models = report.model.byModel
      .map((row) => `${row.model} ${formatUsd(row.usd)}`)
      .join(", ");
    parts.push(
      `This iMessage session: ${formatUsd(report.model.usd)}` +
        (models ? ` (${models}; ${report.model.turns} model turns)` : " (no usage recorded yet)"),
    );
  }
  if (report.sendblue) {
    parts.push(vendorLine("Sendblue", report.sendblue, sendblueSummary));
  }
  if (report.openrouter) {
    parts.push(vendorLine("OpenRouter", report.openrouter, (row) => {
      const monthly = typeof row.usageMonthlyUsd === "number" ? formatUsd(row.usageMonthlyUsd) : "unknown";
      return `this key ${monthly} this month`;
    }));
  }
  if (report.anthropic) {
    parts.push(vendorLine("Anthropic org", report.anthropic, (row) => {
      return typeof row.usd === "number" ? `${formatUsd(row.usd)} this UTC month (whole org)` : "no total";
    }));
  }
  if (report.fly) {
    parts.push("Fly: no billing API for Sprites — this request is holding the box awake");
  }
  return parts.join(". ") + ".";
}

function sendblueSummary(row: Record<string, unknown>): string {
  const count = typeof row.lineCount === "number" ? row.lineCount : 0;
  const published = typeof row.publishedMonthlyUsd === "number" ? formatUsd(row.publishedMonthlyUsd) : "$100";
  return `${count} line(s), published ${published}/mo flat (usage is new-contact caps, not dollars)`;
}

function vendorLine(
  label: string,
  status: VendorStatus,
  okText: (row: Record<string, unknown>) => string,
): string {
  if (!status.ok) return `${label}: ${status.error}`;
  return `${label}: ${okText(status)}`;
}
