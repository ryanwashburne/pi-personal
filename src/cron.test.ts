import { expect, test } from "bun:test";
import { expandCronField, validateCron } from "./cron";

test("validateCron accepts 5-field expressions", () => {
  expect(validateCron("0 8 * * 1")).toBeUndefined();
  expect(validateCron("*/15 9-17 * * 1-5")).toBeUndefined();
  expect(validateCron("0 8,19 * * 1,5")).toBeUndefined();
});

test("validateCron rejects junk", () => {
  expect(validateCron("every monday")).toMatch(/5 fields/i);
  expect(validateCron("0 8 * *")).toMatch(/5 fields/i);
  expect(validateCron("60 8 * * 1")).toMatch(/range/i);
  expect(validateCron("0 8 * * 8")).toMatch(/range/i);
});

test("expandCronField handles star, lists, ranges, and steps", () => {
  expect(expandCronField("*", 0, 3)).toEqual([0, 1, 2, 3]);
  expect(expandCronField("1,5", 0, 7)).toEqual([1, 5]);
  expect(expandCronField("1-3", 0, 7)).toEqual([1, 2, 3]);
  expect(expandCronField("*/15", 0, 59)).toEqual([0, 15, 30, 45]);
  expect(expandCronField("1-5/2", 0, 9)).toEqual([1, 3, 5]);
});
