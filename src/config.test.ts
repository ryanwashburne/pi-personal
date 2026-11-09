import { expect, test } from "bun:test";
import { loadConfig, normalizePhone } from "./config";

const base = {
  WEBHOOK_PATH_SECRET: "path-secret",
  SENDBLUE_API_KEY_ID: "id",
  SENDBLUE_API_KEY_SECRET: "secret",
  SENDBLUE_FROM_NUMBER: "+15551112222",
  SENDBLUE_WEBHOOK_SECRET: "hook-secret",
  ALLOWED_PHONE: "5553334444",
};

test("normalizes 10-digit US numbers to E.164", () => {
  expect(normalizePhone("555-333-4444")).toBe("+15553334444");
  expect(normalizePhone("+1 555 333 4444")).toBe("+15553334444");
});

test("loadConfig requires allowlisted phone", () => {
  const config = loadConfig(base);
  expect(config.allowedPhone).toBe("+15553334444");
  expect(config.port).toBe(8080);
  expect(config.dashboardPathSecret).toBeUndefined();
  expect(config.mcpConfigPath).toBe("/home/sprite/agent/.pi/mcp.json");
  expect(config.userMcpPath.endsWith(".pi/agent/mcp.json")).toBe(true);
});

test("loadConfig reads an optional dashboard secret", () => {
  const config = loadConfig({ ...base, DASHBOARD_SECRET: "dash-secret" });
  expect(config.dashboardPathSecret).toBe("dash-secret");
});

test("loadConfig reads an optional MCP config path", () => {
  const config = loadConfig({ ...base, MCP_CONFIG_PATH: "/tmp/custom-mcp.json" });
  expect(config.mcpConfigPath).toBe("/tmp/custom-mcp.json");
});

test("loadConfig reads an optional user MCP config path", () => {
  const config = loadConfig({ ...base, MCP_USER_CONFIG_PATH: "/tmp/user-mcp.json" });
  expect(config.userMcpPath).toBe("/tmp/user-mcp.json");
});

test("loadConfig reads optional Tailscale exit-node settings", () => {
  const config = loadConfig({
    ...base,
    TAILSCALE_AUTHKEY: '"tskey-auth-test"',
    TAILSCALE_EXIT_NODE: "ryans-macbook.tailnet.ts.net.",
  });
  expect(config.tailscaleAuthKey).toBe("tskey-auth-test");
  expect(config.tailscaleExitNode).toBe("ryans-macbook.tailnet.ts.net");
  expect(config.tailscaleSocksPort).toBe(1055);
});

test("loadConfig throws when required values are missing", () => {
  expect(() => loadConfig({ ...base, SENDBLUE_API_KEY_ID: "" })).toThrow("SENDBLUE_API_KEY_ID");
});
