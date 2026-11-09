import { expect, test } from "bun:test";
import {
  assertHttpUrl,
  parseHttpMethod,
  runWebFetch,
} from "../agent/.pi/extensions/fetch/run";
import { stripHtml } from "../agent/.pi/extensions/fetch/html";

test("parseHttpMethod defaults to GET and rejects unknown methods", () => {
  expect(parseHttpMethod(undefined)).toBe("GET");
  expect(parseHttpMethod("post")).toBe("POST");
  expect(() => parseHttpMethod("TRACE")).toThrow(/Unsupported HTTP method/);
});

test("assertHttpUrl allows only http and https", () => {
  expect(assertHttpUrl("https://example.com/x").host).toBe("example.com");
  expect(() => assertHttpUrl("file:///home/sprite/pi-personal/.env")).toThrow(/http and https/);
  expect(() => assertHttpUrl("not a url")).toThrow(/Invalid URL/);
});

test("stripHtml drops scripts and keeps readable text", () => {
  expect(stripHtml("<html><script>secret()</script><p>Hello</p></html>").trim()).toBe("Hello");
});

test("runWebFetch returns text from a local http server", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("<html><nav>skip</nav><p>fetched ok</p></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  try {
    const result = await runWebFetch({ url: `http://127.0.0.1:${server.port}/` });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.text).toContain("fetched ok");
      expect(result.text).not.toContain("skip");
    }
  } finally {
    server.stop(true);
  }
});

test("runWebFetch rejects file URLs without requesting them", async () => {
  const result = await runWebFetch({ url: "file:///etc/passwd" });
  expect(result).toEqual({ ok: false, error: "Only http and https URLs are allowed." });
});
