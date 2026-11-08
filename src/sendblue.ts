import type { Config } from "./config";

const API_BASE = "https://api.sendblue.com";

export type SendblueClient = {
  sendTyping: (to: string) => Promise<void>;
  sendMessage: (to: string, content: string) => Promise<void>;
};

export function createSendblueClient(config: Config): SendblueClient {
  const headers = {
    "Content-Type": "application/json",
    "sb-api-key-id": config.sendblueApiKeyId,
    "sb-api-secret-key": config.sendblueApiKeySecret,
  };

  return {
    async sendTyping(to) {
      const response = await fetch(`${API_BASE}/api/send-typing-indicator`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          number: to,
          from_number: config.sendblueFromNumber,
        }),
      });
      if (!response.ok) {
        console.warn(`typing indicator failed: ${response.status} ${await response.text()}`);
      }
    },

    async sendMessage(to, content) {
      const body: Record<string, unknown> = {
        number: to,
        from_number: config.sendblueFromNumber,
        content,
      };
      const response = await fetch(`${API_BASE}/api/send-message`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`send-message failed: ${response.status} ${await response.text()}`);
      }
    },
  };
}
