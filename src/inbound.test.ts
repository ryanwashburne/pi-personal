import { expect, test } from "bun:test";
import { parseInbound, promptFromInbound } from "./inbound";

test("parses inbound sendblue payloads", () => {
  const message = parseInbound({
    is_outbound: false,
    from_number: "+15551230000",
    message_handle: "abc",
    content: "hello",
  });
  expect(message).toEqual({
    messageHandle: "abc",
    fromNumber: "+15551230000",
    content: "hello",
    mediaUrl: undefined,
  });
});

test("ignores outbound and empty payloads", () => {
  expect(parseInbound({ is_outbound: true, from_number: "+1", message_handle: "x", content: "hi" })).toBeUndefined();
  expect(parseInbound({ from_number: "+1", message_handle: "x" })).toBeUndefined();
});

test("includes media URLs in the prompt", () => {
  expect(
    promptFromInbound({
      messageHandle: "1",
      fromNumber: "+1",
      content: "see this",
      mediaUrl: "https://cdn.example/file.jpg",
    }),
  ).toContain("https://cdn.example/file.jpg");
});
