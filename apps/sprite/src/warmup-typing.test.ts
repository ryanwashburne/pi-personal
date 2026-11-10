import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("provision.sh enables Sendblue auto-typing from the laptop, not the Sprite process", () => {
  const script = readFileSync(join(root, "scripts/provision.sh"), "utf8");
  expect(script).toContain("https://api.sendblue.com/accounts/settings/auto-typing-indicator");
  expect(script).toContain('"auto_typing_indicator": true');
  const enableAt = script.indexOf("accounts/settings/auto-typing-indicator");
  const before = script.slice(Math.max(0, enableAt - 800), enableAt);
  expect(before).not.toMatch(/sprite exec/);
});

test("gateway boot does not await auto-typing before listen", () => {
  const index = readFileSync(join(root, "src/index.ts"), "utf8");
  expect(index).toMatch(/void sendblue\.enableAutoTyping/);
  expect(index).not.toMatch(/await sendblue\.enableAutoTyping/);
  const listenAt = index.indexOf("Bun.serve");
  const enableAt = index.indexOf("enableAutoTyping");
  expect(listenAt).toBeGreaterThan(0);
  expect(enableAt).toBeGreaterThan(0);
});
