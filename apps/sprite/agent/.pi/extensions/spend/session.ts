import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_SESSION_FILES = 50;
const MAX_SESSION_BYTES = 20 * 1024 * 1024;

export type ModelSpendRow = {
  provider: string;
  model: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
};

export type SessionSpend = {
  ok: true;
  files: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  byModel: ModelSpendRow[];
  note: string;
};

type UsageBlock = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
};

type SessionEntry = {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  provider?: string;
  model?: string;
  usage?: UsageBlock;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    usage?: UsageBlock;
  };
};

export function defaultSessionDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return env.SESSION_DIR?.trim() || join(cwd, "sessions");
}

export function listSessionFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[];
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    files.push(path);
    if (files.length >= MAX_SESSION_FILES) break;
  }
  return files;
}

export function readSessionTexts(dir: string): string[] {
  const texts: string[] = [];
  for (const path of listSessionFiles(dir)) {
    try {
      if (statSync(path).size > MAX_SESSION_BYTES) continue;
      texts.push(readFileSync(path, "utf8"));
    } catch {
      // skip unreadable files
    }
  }
  return texts;
}

export function summarizeSessionTexts(texts: string[]): SessionSpend {
  const byModel = new Map<string, ModelSpendRow>();
  let files = 0;

  for (const text of texts) {
    const pathSpend = spendOnActivePath(parseEntries(text));
    if (!pathSpend) continue;
    files += 1;
    for (const row of pathSpend) mergeRow(byModel, row);
  }

  const rows = [...byModel.values()].sort((a, b) => b.usd - a.usd);
  const totals = rows.reduce(
    (acc, row) => {
      acc.usd += row.usd;
      acc.inputTokens += row.inputTokens;
      acc.outputTokens += row.outputTokens;
      acc.cacheReadTokens += row.cacheReadTokens;
      acc.cacheWriteTokens += row.cacheWriteTokens;
      acc.turns += row.turns;
      return acc;
    },
    {
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 0,
    },
  );

  return {
    ok: true,
    files,
    ...totals,
    byModel: rows,
    note: "Pi-recorded usage on the current branch of each session file. Not the vendor invoice. Does not include other apps on the same API key.",
  };
}

export function parseEntries(text: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as SessionEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

export function spendOnActivePath(entries: SessionEntry[]): ModelSpendRow[] | undefined {
  const tree = entries.filter((entry) => entry.type !== "session" && typeof entry.id === "string");
  if (tree.length === 0) return undefined;

  const byId = new Map<string, SessionEntry>();
  const children = new Set<string>();
  for (const entry of tree) {
    const id = entry.id;
    if (!id) continue;
    byId.set(id, entry);
    if (typeof entry.parentId === "string") children.add(entry.parentId);
  }

  let leaf: SessionEntry | undefined;
  for (const entry of tree) {
    if (!entry.id || children.has(entry.id)) continue;
    if (!leaf || (entry.timestamp ?? "") > (leaf.timestamp ?? "")) leaf = entry;
  }
  if (!leaf?.id) leaf = tree[tree.length - 1];
  if (!leaf?.id) return undefined;

  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current?.id && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    const parentId: string | null | undefined = current.parentId;
    current = typeof parentId === "string" ? byId.get(parentId) : undefined;
  }

  const byModel = new Map<string, ModelSpendRow>();
  for (const entry of path) {
    const usage = usageFrom(entry);
    if (!usage) continue;
    mergeRow(byModel, {
      provider: providerFrom(entry),
      model: modelFrom(entry),
      usd: usage.cost?.total ?? 0,
      inputTokens: usage.input ?? 0,
      outputTokens: usage.output ?? 0,
      cacheReadTokens: usage.cacheRead ?? 0,
      cacheWriteTokens: usage.cacheWrite ?? 0,
      turns: entry.type === "message" && entry.message?.role === "assistant" ? 1 : 0,
    });
  }
  return [...byModel.values()];
}

function usageFrom(entry: SessionEntry): UsageBlock | undefined {
  if (entry.usage) return entry.usage;
  if (entry.message?.usage) return entry.message.usage;
  return undefined;
}

function providerFrom(entry: SessionEntry): string {
  return entry.provider || entry.message?.provider || "unknown";
}

function modelFrom(entry: SessionEntry): string {
  return entry.model || entry.message?.model || "unknown";
}

function mergeRow(byModel: Map<string, ModelSpendRow>, row: ModelSpendRow): void {
  const key = `${row.provider}/${row.model}`;
  const existing = byModel.get(key);
  if (!existing) {
    byModel.set(key, { ...row });
    return;
  }
  existing.usd += row.usd;
  existing.inputTokens += row.inputTokens;
  existing.outputTokens += row.outputTokens;
  existing.cacheReadTokens += row.cacheReadTokens;
  existing.cacheWriteTokens += row.cacheWriteTokens;
  existing.turns += row.turns;
}
