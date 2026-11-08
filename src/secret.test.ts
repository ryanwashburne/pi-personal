import { expect, test } from "bun:test";
import { secretsEqual } from "./secret";

test("accepts matching secrets", () => {
  expect(secretsEqual("abc", "abc")).toBe(true);
});

test("rejects missing or mismatched secrets", () => {
  expect(secretsEqual(undefined, "abc")).toBe(false);
  expect(secretsEqual("ab", "abc")).toBe(false);
  expect(secretsEqual("abd", "abc")).toBe(false);
});
