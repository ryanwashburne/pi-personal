import { join } from "node:path";
import { attachVncWebSocket, toBuffer, vncProtocolHeaders, type VncProxy } from "./vnc-proxy";
import { handleBrowserEnsure } from "./browser-ensure";
import { createBrowserSession } from "./browser-session";
import { loadConfig } from "./config";
import { browserWsPath } from "./dashboard";
import { createPiAgent } from "./pi";
import { internalListenPort } from "./playwright-mcp";
import { createSendblueClient } from "./sendblue";
import { createTailscale } from "./tailscale";
import { createFetchHandler, createGateway } from "./webhook";

const proxies = new WeakMap<object, VncProxy>();

const config = loadConfig();
const internalPort = internalListenPort();
process.env.INTERNAL_PORT = String(internalPort);
const pi = createPiAgent(config);
const tailscale = createTailscale({
  stateDir: join(process.cwd(), "tailscale-state"),
  authKey: config.tailscaleAuthKey,
  exitNode: config.tailscaleExitNode,
  socksPort: config.tailscaleSocksPort,
});
const browser = createBrowserSession({
  agentCwd: config.agentCwd,
  requireProxy: Boolean(config.tailscaleExitNode),
  async ensureNetwork() {
    await tailscale.start();
    const status = tailscale.status();
    return { proxyUrl: status.socksUrl, exitNode: status.exitNode };
  },
});
const sendblue = createSendblueClient(config);
void sendblue.enableAutoTyping?.().catch((error) => {
  console.warn("auto typing failed", error);
});
const gatewayPromise = createGateway({
  config,
  sendblue,
  pi,
  browser,
  tailscale,
});
gatewayPromise.catch((error) => {
  console.error("gateway init failed", error);
  process.exit(1);
});
const handleHttp = createFetchHandler({ config, sendblue, gateway: gatewayPromise });
const wsPath = browserWsPath(config);

const internal = Bun.serve({
  hostname: "127.0.0.1",
  port: internalPort,
  async fetch(request) {
    const result = await handleBrowserEnsure(request, browser);
    return new Response(result.body, { status: result.status, headers: result.headers });
  },
});

const server = Bun.serve({
  port: config.port,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    if (wsPath && url.pathname === wsPath) {
      if (!browser.status().running) {
        return new Response("browser is not running", { status: 503 });
      }
      const headers = vncProtocolHeaders(request);
      if (bunServer.upgrade(request, headers ? { headers } : {})) return;
      return new Response("upgrade failed", { status: 400 });
    }

    return handleHttp(request);
  },
  websocket: {
    idleTimeout: 600,
    async open(ws) {
      try {
        const proxy = await attachVncWebSocket(
          {
            send(data) {
              ws.send(data instanceof Uint8Array ? data : new Uint8Array(toBuffer(data)));
            },
            close() {
              ws.close();
            },
          },
          browser.vncPort(),
        );
        proxies.set(ws, proxy);
      } catch (error) {
        console.warn("vnc proxy failed", error);
        ws.close();
      }
    },
    message(ws, message) {
      proxies.get(ws)?.write(toBuffer(message));
    },
    close(ws) {
      proxies.get(ws)?.end();
      proxies.delete(ws);
    },
  },
});

console.log(`pi-personal listening on :${server.port}; browser ensure on 127.0.0.1:${internal.port}`);

process.on("SIGTERM", () => {
  void (async () => {
    await browser.stop();
    await tailscale.stop();
    await pi.stop();
    server.stop();
    internal.stop();
    process.exit(0);
  })();
});
