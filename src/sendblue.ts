import type { Config } from "./config";

const API_BASE = "https://api.sendblue.com";

/** iMessage typing expires on its own; 5 minutes is Sendblue's maximum. */
export const TYPING_MAX_DURATION_MS = 300_000;
/** First attempt is short so a cold Sprite DNS/TLS blip falls back quickly. */
const TYPING_TIMEOUTS_MS = [1_500, 8_000] as const;
const AUTO_TYPING_ATTEMPTS = 3;

export type SendblueFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type SendblueClient = {
  sendTyping: (to: string) => Promise<void>;
  sendMessage: (to: string, content: string) => Promise<void>;
  enableAutoTyping?: () => Promise<void>;
};

export function createSendblueClient(config: Config, fetchFn: SendblueFetch = fetch): SendblueClient {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "pi-personal/1.0",
    "sb-api-key-id": config.sendblueApiKeyId,
    "sb-api-secret-key": config.sendblueApiKeySecret,
  };

  async function post(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    return fetchFn(`${API_BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    async sendTyping(to) {
      let body: Record<string, unknown> = {
        number: to,
        from_number: config.sendblueFromNumber,
        state: "start",
        max_duration_ms: TYPING_MAX_DURATION_MS,
      };
      for (let attempt = 0; attempt < TYPING_TIMEOUTS_MS.length; attempt++) {
        const timeoutMs = TYPING_TIMEOUTS_MS[attempt] ?? 15_000;
        try {
          const response = await post("/api/send-typing-indicator", body, timeoutMs);
          if (response.ok) return;
          const text = await response.text();
          console.warn(`typing indicator failed: ${response.status} ${text}`);
          if (response.status === 503 && "max_duration_ms" in body) {
            body = { number: to, from_number: config.sendblueFromNumber };
            continue;
          }
          if (response.status >= 400 && response.status < 500 && response.status !== 429) return;
        } catch (error) {
          console.warn("typing failed", error);
          if (attempt === TYPING_TIMEOUTS_MS.length - 1) return;
        }
      }
    },

    async sendMessage(to, content) {
      const body: Record<string, unknown> = {
        number: to,
        from_number: config.sendblueFromNumber,
        content,
      };
      const response = await post("/api/send-message", body, 15_000);
      if (!response.ok) {
        throw new Error(`send-message failed: ${response.status} ${await response.text()}`);
      }
    },

    async enableAutoTyping() {
      for (let attempt = 0; attempt < AUTO_TYPING_ATTEMPTS; attempt++) {
        try {
          const response = await post(
            "/accounts/settings/auto-typing-indicator",
            { auto_typing_indicator: true },
            10_000,
          );
          if (response.ok) {
            console.log("sendblue auto typing enabled");
            return;
          }
          console.warn(`auto typing enable failed: ${response.status} ${await response.text()}`);
          if (response.status >= 400 && response.status < 500 && response.status !== 429) return;
        } catch (error) {
          console.warn("auto typing failed", error);
        }
        if (attempt < AUTO_TYPING_ATTEMPTS - 1) {
          await delay(250 * (attempt + 1));
        }
      }
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
