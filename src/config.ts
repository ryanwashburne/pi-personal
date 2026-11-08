import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  port: number;
  webhookPathSecret: string;
  dashboardPathSecret: string | undefined;
  sendblueApiKeyId: string;
  sendblueApiKeySecret: string;
  sendblueFromNumber: string;
  sendblueWebhookSecret: string;
  allowedPhone: string;
  piCli: string;
  agentCwd: string;
  sessionDir: string;
  mcpConfigPath: string;
  agentTimeoutMs: number;
  piProvider: string | undefined;
  piModel: string | undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowedPhone = normalizePhone(
    env.ALLOWED_PHONE ??
      (() => {
        throw new Error("Missing required env var ALLOWED_PHONE");
      })(),
  );
  if (!allowedPhone) {
    throw new Error("ALLOWED_PHONE must be an E.164 number like +15551234567");
  }

  return {
    port: Number(env.PORT ?? 8080),
    webhookPathSecret: requiredFrom(env, "WEBHOOK_PATH_SECRET"),
    dashboardPathSecret: emptyToUndefined(env.DASHBOARD_SECRET),
    sendblueApiKeyId: requiredFrom(env, "SENDBLUE_API_KEY_ID"),
    sendblueApiKeySecret: requiredFrom(env, "SENDBLUE_API_KEY_SECRET"),
    sendblueFromNumber: normalizePhone(requiredFrom(env, "SENDBLUE_FROM_NUMBER")) ??
      requiredFrom(env, "SENDBLUE_FROM_NUMBER"),
    sendblueWebhookSecret: requiredFrom(env, "SENDBLUE_WEBHOOK_SECRET"),
    allowedPhone,
    piCli: env.PI_CLI?.trim() || "pi",
    agentCwd: env.AGENT_CWD?.trim() || "/home/sprite/agent",
    sessionDir: env.SESSION_DIR?.trim() || "/home/sprite/agent/sessions",
    mcpConfigPath: env.MCP_CONFIG_PATH?.trim() || join(homedir(), ".pi/agent/mcp.json"),
    agentTimeoutMs: Number(env.AGENT_TIMEOUT_MS ?? 600_000),
    piProvider: emptyToUndefined(env.PI_PROVIDER),
    piModel: emptyToUndefined(env.PI_MODEL),
  };
}

function requiredFrom(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizePhone(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const digits = trimmed.replace(/[^\d+]/g, "");
  if (digits.startsWith("+") && digits.length >= 11) return digits;
  if (/^\d{11}$/.test(digits) && digits.startsWith("1")) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return undefined;
}
