import type { BrowserSession } from "./browser-session";
import { BROWSER_ENSURE_PATH } from "./playwright-mcp";
import type { GatewayResult } from "./result";

export async function handleBrowserEnsure(
  request: Request,
  browser: BrowserSession,
): Promise<GatewayResult> {
  const url = new URL(request.url);
  if (url.pathname !== BROWSER_ENSURE_PATH) {
    return { status: 404, body: "not found" };
  }
  if (request.method !== "POST") {
    return { status: 405, body: "method not allowed" };
  }
  try {
    await browser.start({ hold: false });
    const status = browser.status();
    if (!status.running) {
      return { status: 503, body: status.error ?? "browser is not running" };
    }
    return {
      status: 200,
      body: JSON.stringify({ running: true, profileDir: status.profileDir }),
      headers: { "content-type": "application/json" },
    };
  } catch (error) {
    return { status: 503, body: error instanceof Error ? error.message : String(error) };
  }
}
