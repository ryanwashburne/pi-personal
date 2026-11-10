import { stripHtml } from "./html";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TEXT_CHARS = 100 * 1024;

export type FetchRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  textOnly?: boolean;
};

export type FetchSuccess = {
  ok: true;
  status: number;
  statusText: string;
  contentType: string;
  truncated: boolean;
  text: string;
};

export type FetchFailure = {
  ok: false;
  error: string;
};

export function parseHttpMethod(value: string | undefined): HttpMethod {
  const method = (value ?? "GET").toUpperCase();
  for (const allowed of HTTP_METHODS) {
    if (allowed === method) return allowed;
  }
  throw new Error(`Unsupported HTTP method: ${value ?? ""}`);
}

export function assertHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed.");
  }
  return parsed;
}

export async function runWebFetch(
  request: FetchRequest,
  signal?: AbortSignal,
): Promise<FetchSuccess | FetchFailure> {
  let method: HttpMethod;
  let parsed: URL;
  try {
    method = parseHttpMethod(request.method);
    parsed = assertHttpUrl(request.url);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid fetch request" };
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(parsed, {
      method,
      headers: request.headers,
      body: request.body,
      redirect: "follow",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    const shouldStrip =
      request.textOnly === true || (request.textOnly !== false && contentType.includes("text/html"));
    let text = shouldStrip ? stripHtml(raw) : raw;
    const truncated = text.length > DEFAULT_MAX_TEXT_CHARS;
    if (truncated) text = text.slice(0, DEFAULT_MAX_TEXT_CHARS);

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status} ${response.statusText}\n${text.slice(0, 2000)}`.trim(),
      };
    }

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      contentType,
      truncated,
      text,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      error: timedOut
        ? `Timed out after ${timeoutMs}ms: ${parsed.href}`
        : error instanceof Error
          ? error.message
          : "Unknown fetch error",
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
