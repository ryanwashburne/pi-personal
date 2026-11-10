import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { formatUsd, parseSpendVendor, runSpend } from "../agent/.pi/extensions/spend/run";
import { redactPhone, utcMonthStartIso } from "../agent/.pi/extensions/spend/vendors";
import {
  parseEntries,
  readSessionTexts,
  spendOnActivePath,
  summarizeSessionTexts,
} from "../agent/.pi/extensions/spend/session";

test("parseSpendVendor defaults to all and rejects unknown", () => {
  expect(parseSpendVendor(undefined)).toBe("all");
  expect(parseSpendVendor("model")).toBe("model");
  expect(() => parseSpendVendor("stripe")).toThrow(/Unknown vendor/);
});

test("redactPhone keeps last four digits only", () => {
  expect(redactPhone("+15550100001")).toBe("+…0001");
});

test("session spend follows the latest leaf and ignores abandoned branches", () => {
  const jsonl = [
    { type: "session", id: "sess", timestamp: "2026-11-01T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-11-01T00:01:00.000Z", message: { role: "user", content: "secret password" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-11-01T00:02:00.000Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
      },
    },
    { type: "message", id: "uA", parentId: "a1", timestamp: "2026-11-01T00:03:00.000Z", message: { role: "user", content: "abandoned" } },
    {
      type: "message",
      id: "aA",
      parentId: "uA",
      timestamp: "2026-11-01T00:04:00.000Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-5-5",
        usage: { input: 9999, output: 9999, cost: { total: 10 } },
      },
    },
    { type: "message", id: "uB", parentId: "a1", timestamp: "2026-11-01T00:05:00.000Z", message: { role: "user", content: "keep going" } },
    {
      type: "message",
      id: "aB",
      parentId: "uB",
      timestamp: "2026-11-01T00:06:00.000Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        usage: { input: 50, output: 10, cost: { total: 0.002 } },
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  const rows = spendOnActivePath(parseEntries(jsonl));
  expect(rows).toHaveLength(1);
  expect(rows?.[0]?.provider).toBe("anthropic");
  expect(rows?.[0]?.model).toBe("claude-haiku-5-5");
  expect(rows?.[0]?.usd).toBeCloseTo(0.012);
  expect(rows?.[0]?.inputTokens).toBe(150);
  expect(rows?.[0]?.outputTokens).toBe(30);
  expect(rows?.[0]?.turns).toBe(2);
});

test("runSpend model report does not include message bodies", async () => {
  const jsonl = `${JSON.stringify({
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: "2026-11-01T00:00:00.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      content: "do not leak this transcript",
      usage: { input: 10, output: 4, cost: { total: 0.0004 } },
    },
  })}\n`;
  const report = await runSpend("model", { sessionTexts: [jsonl], env: {} });
  const dumped = JSON.stringify(report);
  expect(dumped).not.toContain("do not leak this transcript");
  expect(report.model?.usd).toBe(0.0004);
  expect(report.summary).toContain("$0.0004");
});

test("runSpend sendblue redacts phones and does not treat usage as dollars", async () => {
  const fetchFn = async () =>
    new Response(
      JSON.stringify({
        status: "OK",
        enabled: true,
        lines: [
          {
            phone: "+15550100001",
            state: "not_applicable",
            daily: { used: 0, limit: 1000, remaining: 1000 },
          },
        ],
      }),
      { status: 200 },
    );
  const report = await runSpend("sendblue", {
    env: { SENDBLUE_API_KEY_ID: "id", SENDBLUE_API_KEY_SECRET: "secret" },
    fetchFn,
  });
  expect(report.sendblue?.ok).toBe(true);
  const dumped = JSON.stringify(report);
  expect(dumped).not.toContain("+15550100001");
  expect(dumped).toContain("+…0001");
  if (report.sendblue && report.sendblue.ok) {
    expect(report.sendblue.publishedMonthlyUsd).toBe(100);
  }
});

test("runSpend openrouter maps key usage fields", async () => {
  const fetchFn = async (url: string) => {
    if (url.includes("/credits")) {
      return new Response(JSON.stringify({ error: { code: 403, message: "management key" } }), { status: 403 });
    }
    expect(url).toContain("/api/v1/key");
    return new Response(
      JSON.stringify({
        data: { usage: 25.5, usage_monthly: 3.2, limit: 100, limit_remaining: 74.5, label: "sk-or-v1-secret" },
      }),
      { status: 200 },
    );
  };
  const report = await runSpend("openrouter", {
    env: { OPENROUTER_API_KEY: "sk-or-v1-test" },
    fetchFn,
  });
  expect(report.openrouter).toMatchObject({
    ok: true,
    usageUsd: 25.5,
    usageMonthlyUsd: 3.2,
    limitRemainingUsd: 74.5,
  });
  expect(report.openrouter && report.openrouter.ok ? report.openrouter.totalCreditsUsd : undefined).toBeUndefined();
  expect(JSON.stringify(report)).not.toContain("sk-or-v1-secret");
  expect(JSON.stringify(report)).not.toContain("sk-or-v1-test");
});

test("runSpend openrouter includes credits remaining when GET /credits is allowed", async () => {
  const fetchFn = async (url: string) => {
    if (url.includes("/credits")) {
      return new Response(JSON.stringify({ data: { total_credits: 50, total_usage: 12.5 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { usage: 12.5, usage_monthly: 12.5 } }), { status: 200 });
  };
  const report = await runSpend("openrouter", {
    env: { OPENROUTER_API_KEY: "sk-or-v1-test" },
    fetchFn,
  });
  expect(report.openrouter).toMatchObject({
    ok: true,
    totalCreditsUsd: 50,
    totalUsageUsd: 12.5,
    creditsRemainingUsd: 37.5,
  });
});

test("runSpend vendor=anthropic without keys does not invent a total", async () => {
  const report = await runSpend("anthropic", { env: {}, fetchFn: async () => new Response("no", { status: 500 }) });
  expect(report.anthropic).toMatchObject({ ok: false });
  expect(JSON.stringify(report.anthropic)).toMatch(/OpenRouter/);
});

test("runSpend anthropic converts cents strings and is org-wide", async () => {
  const now = new Date("2026-11-09T12:00:00.000Z");
  const fetchFn = async (url: string) => {
    expect(url).toContain("starting_at=2026-11-01T00%3A00%3A00.000Z");
    return new Response(
      JSON.stringify({
        data: [
          {
            starting_at: "2026-11-01T00:00:00Z",
            results: [
              { amount: "123.45", currency: "USD", model: "claude-haiku-5-5", cost_type: "tokens" },
              { amount: "50", currency: "USD", model: "claude-haiku-5-5", cost_type: "tokens" },
            ],
          },
        ],
      }),
      { status: 200 },
    );
  };
  const report = await runSpend("anthropic", {
    env: { ANTHROPIC_ADMIN_API_KEY: "sk-ant-admin01-test" },
    fetchFn,
    now,
  });
  expect(utcMonthStartIso(now)).toBe("2026-11-01T00:00:00.000Z");
  expect(report.anthropic).toMatchObject({ ok: true, usd: 1.7345 });
});

test("runSpend skips vendors with no keys instead of inventing amounts", async () => {
  const report = await runSpend("all", {
    env: { ANTHROPIC_API_KEY: "sk-ant-unused" },
    sessionTexts: [],
    fetchFn: async () => new Response("no", { status: 500 }),
  });
  expect(report.model?.usd).toBe(0);
  expect(report.sendblue).toMatchObject({ ok: false });
  expect(report.openrouter).toMatchObject({ ok: false });
  expect(report.anthropic).toBeUndefined();
  expect(report.fly).toMatchObject({ ok: false, vendor: "fly" });
  expect(report.summary).toMatch(/no billing API/i);
  expect(report.summary).not.toMatch(/Anthropic/);
});

test("summarizeSessionTexts reads jsonl from a session directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-spend-"));
  mkdirSync(join(dir, "nested"));
  writeFileSync(
    join(dir, "nested", "imessage.jsonl"),
    `${JSON.stringify({
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: "2026-11-01T00:00:00.000Z",
      message: { role: "assistant", provider: "anthropic", model: "claude-haiku-5-5", usage: { cost: { total: 0.5 } } },
    })}\n`,
  );
  expect(summarizeSessionTexts(readSessionTexts(dir)).usd).toBe(0.5);
});

test("formatUsd uses four decimals under a cent", () => {
  expect(formatUsd(0)).toBe("$0");
  expect(formatUsd(0.0004)).toBe("$0.0004");
  expect(formatUsd(1.5)).toBe("$1.50");
});
