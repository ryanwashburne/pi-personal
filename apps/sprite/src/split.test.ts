import { expect, test } from "bun:test";
import { splitMessage } from "./split";

test("keeps short messages intact", () => {
  expect(splitMessage("hello")).toEqual(["hello"]);
});

test("splits on paragraphs before mid-word cuts", () => {
  const text = `${"a".repeat(40)}\n\n${"b".repeat(40)}`;
  expect(splitMessage(text, 50)).toEqual(["a".repeat(40), "b".repeat(40)]);
});
