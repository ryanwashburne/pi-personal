import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const policyPath = join(import.meta.dir, "../agent/.cc-safety-net/policy.json");
const provisionPath = join(import.meta.dir, "../scripts/provision.sh");

type Policy = {
  version: number;
  secret_protection?: {
    enabled?: boolean;
    deny_paths?: string[];
  };
};

function loadPolicy(): Policy {
  return JSON.parse(readFileSync(policyPath, "utf8")) as Policy;
}

test("CC Safety Net policy is valid JSON with deny-only extra paths", () => {
  const policy = loadPolicy();
  expect(policy.version).toBe(1);
  expect(policy.secret_protection?.enabled).toBe(true);
  expect(policy.secret_protection?.deny_paths).toEqual([
    "browser-profile",
    "sessions",
    ".pi/mcp.json",
    "~/.pi/agent/mcp.json",
    "/home/sprite/pi-personal/.env",
  ]);
});

test("CC Safety Net policy does not block logins.md or live-view.md", () => {
  const deny = loadPolicy().secret_protection?.deny_paths ?? [];
  expect(deny.some((path) => path.includes("logins.md"))).toBe(false);
  expect(deny.some((path) => path.includes("live-view.md"))).toBe(false);
});

test("provision installs cc-safety-net into Pi", () => {
  const provision = readFileSync(provisionPath, "utf8");
  expect(provision).toContain("pi install npm:cc-safety-net");
});
