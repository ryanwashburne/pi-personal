import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { GoogleFetch } from "./google-oauth";
import {
  CALENDAR_API,
  callGoogleTool,
  DRIVE_API,
  GMAIL_API,
  toolsForGoogleService,
} from "./google-rest";
import { parseGoogleMcpService, serveGoogleRestMcp } from "./google-rest-mcp";

type Call = { method: string; url: string; body?: string };

function restDeps(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fetchImpl: GoogleFetch = async (input, init) => {
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      body: init?.body === undefined ? undefined : String(init.body),
    };
    calls.push(call);
    const payload = handler(call);
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    deps: {
      token: async () => "ya29.test",
      fetchImpl,
      now: () => Date.parse("2026-11-09T12:00:00.000Z"),
    },
  };
}

test("gmail search uses Gmail REST and does not send", async () => {
  const { calls, deps } = restDeps((call) => {
    if (call.url.includes("/messages?") && call.method === "GET") {
      return { messages: [{ id: "m1", threadId: "t1" }], resultSizeEstimate: 1 };
    }
    if (call.url.includes("/messages/m1")) {
      return {
        id: "m1",
        threadId: "t1",
        snippet: "hello",
        payload: { headers: [{ name: "Subject", value: "Hi" }, { name: "From", value: "a@b.com" }] },
      };
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  });
  const result = await callGoogleTool("gmail", "search_emails", { q: "in:inbox", maxResults: 5 }, deps);
  expect(calls[0]?.url).toContain(`${GMAIL_API}/users/me/messages?`);
  expect(calls[0]?.url).toContain("q=in%3Ainbox");
  expect(calls[0]?.url).toContain("maxResults=5");
  expect(result.content[0]?.text).toContain("m1");
  expect(result.content[0]?.text).toContain("Hi");
  expect(toolsForGoogleService("gmail").some((tool) => tool.name === "send_email")).toBe(false);
});

test("create_draft posts base64url MIME and never hits send", async () => {
  const { calls, deps } = restDeps((call) => {
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${GMAIL_API}/users/me/drafts`);
    return { id: "d1", message: { id: "m2" } };
  });
  await callGoogleTool(
    "gmail",
    "create_draft",
    { to: ["you@example.com"], subject: "Hello", body: "Hi there" },
    deps,
  );
  const raw = JSON.parse(calls[0]?.body ?? "{}") as { message: { raw: string } };
  const mime = Buffer.from(raw.message.raw, "base64url").toString("utf8");
  expect(mime).toContain("To: you@example.com");
  expect(mime).toContain("Subject: Hello");
  expect(mime).toContain("Hi there");
  expect(calls.some((call) => call.url.includes("/send"))).toBe(false);
});

test("calendar list_events defaults to a window around now", async () => {
  const { calls, deps } = restDeps(() => ({ items: [] }));
  await callGoogleTool("calendar", "list_events", {}, deps);
  expect(calls[0]?.url.startsWith(`${CALENDAR_API}/calendars/primary/events?`)).toBe(true);
  expect(calls[0]?.url).toContain("timeMin=2026-11-02T12%3A00%3A00.000Z");
  expect(calls[0]?.url).toContain("timeMax=2026-11-30T12%3A00%3A00.000Z");
});

test("drive search turns plain text into a Drive query", async () => {
  const { calls, deps } = restDeps(() => ({ files: [] }));
  await callGoogleTool("drive", "search_files", { q: "taxes 2025" }, deps);
  expect(calls[0]?.url.startsWith(`${DRIVE_API}/files?`)).toBe(true);
  const q = new URL(calls[0]?.url ?? "https://invalid").searchParams.get("q") ?? "";
  expect(q).toContain("fullText contains 'taxes 2025'");
  expect(q).toContain("name contains 'taxes 2025'");
});

test("search_corpus fans out to Gmail, Calendar, and Drive", async () => {
  const { calls, deps } = restDeps((call) => {
    if (call.url.includes("/gmail.googleapis.com/")) {
      return { messages: [], resultSizeEstimate: 0 };
    }
    if (call.url.includes("/calendar/v3/")) return { items: [] };
    if (call.url.includes("/drive/v3/")) return { files: [] };
    throw new Error(`unexpected ${call.url}`);
  });
  const result = await callGoogleTool("search", "search_corpus", { query: "dentist" }, deps);
  const hosts = calls.map((call) => new URL(call.url).host).sort();
  expect(hosts).toEqual(["gmail.googleapis.com", "www.googleapis.com", "www.googleapis.com"].sort());
  const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { query?: string; gmail?: unknown; calendar?: unknown; drive?: unknown };
  expect(parsed.query).toBe("dentist");
  expect(parsed.gmail).toBeDefined();
  expect(parsed.calendar).toBeDefined();
  expect(parsed.drive).toBeDefined();
  expect(calls.some((call) => call.url.includes("mcp.googleapis.com"))).toBe(false);
});

test("Google API errors surface as tool failures", async () => {
  const { deps } = restDeps(
    () =>
      new Response(JSON.stringify({ error: { message: "Insufficient Permission" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
  );
  await expect(callGoogleTool("gmail", "list_labels", {}, deps)).rejects.toThrow(/Insufficient Permission/);
});

test("parseGoogleMcpService accepts the four local servers", () => {
  expect(parseGoogleMcpService("search")).toBe("search");
  expect(() => parseGoogleMcpService("chat")).toThrow(/Usage/);
});

test("gmail MCP stdio lists tools and searches over REST", async () => {
  const { deps } = restDeps((call) => {
    if (call.url.includes("/messages?")) return { messages: [], resultSizeEstimate: 0 };
    throw new Error(`unexpected ${call.url}`);
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.setEncoding("utf8");
  let buffer = "";
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      lines.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  const serving = serveGoogleRestMcp("gmail", { input, output, token: deps.token, fetchImpl: deps.fetchImpl });
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`,
  );
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_emails", arguments: { q: "from:me" } } })}\n`,
  );
  input.end();
  await serving;
  const listed = JSON.parse(lines[1] ?? "{}") as { result?: { tools?: Array<{ name: string }> } };
  expect(listed.result?.tools?.map((tool) => tool.name)).toEqual([
    "search_emails",
    "get_email",
    "create_draft",
    "list_labels",
    "modify_labels",
  ]);
  const called = JSON.parse(lines[2] ?? "{}") as { result?: { content?: Array<{ text: string }> } };
  expect(called.result?.content?.[0]?.text).toContain("resultSizeEstimate");
});
