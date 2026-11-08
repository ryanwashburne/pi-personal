import { expect, test } from "bun:test";
import { loadConfig, normalizePhone } from "./config";

const base = {
  WEBHOOK_PATH_SECRET: "path-secret",
  SENDBLUE_API_KEY_ID: "id",
  SENDBLUE_API_KEY_SECRET: "secret",
  SENDBLUE_FROM_NUMBER: "+15551112222",
  SENDBLUE_WEBHOOK_SECRET: "hook-secret",
  ALLOWED_PHONE: "5553334444",
};

test("normalizes 10-digit US numbers to E.164", () => {
  expect(normalizePhone("555-333-4444")).toBe("+15553334444");
  expect(normalizePhone("+1 555 333 4444")).toBe("+15553334444");
});

test("loadConfig requires allowlisted phone", () => {
  const config = loadConfig(base);
  expect(config.allowedPhone).toBe("+15553334444");
  expect(config.port).toBe(8080);
});

test("loadConfig throws when required values are missing", () => {
  expect(() => loadConfig({ ...base, SENDBLUE_API_KEY_ID: "" })).toThrow("SENDBLUE_API_KEY_ID");
});
