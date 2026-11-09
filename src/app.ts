import { join } from "node:path";
import { handleBrowserEnsure } from "./browser-ensure";
import { createBrowserSession, type BrowserSession } from "./browser-session";
import type { Config } from "./config";
import { browserWsPath } from "./dashboard";
import { createPiAgent } from "./pi";
import { internalListenPort } from "./playwright-mcp";
import type { SendblueClient } from "./sendblue";
import { createTailscale } from "./tailscale";
import { attachVncWebSocket, toBuffer, vncProtocolHeaders, type VncProxy } from "./vnc-proxy";
import { createGateway, type Gateway } from "./webhook";

export type App = {
  gateway: Gateway;
  wsPath: string | undefined;
  browser: BrowserSession;
  handleUpgrade: (
    request: Request,
    bunServer: { upgrade: (request: Request, options?: { headers?: HeadersInit }) => boolean },
  ) => Promise<"upgraded" | Response | undefined>;
  websocket: {
    idleTimeout: number;
    open: (ws: WsSink) => Promise<void>;
    message: (ws: WsSink, message: string | Buffer | Uint8Array) => void;
    close: (ws: WsSink) => void;
  };
  stop: () => Promise<void>;
};

type WsSink = {
  send: (data: string | Uint8Array) => void;
  close: () => void;
};

export async function startApp(options: { config: Config; sendblue: SendblueClient }): Promise<App> {
  const { config, sendblue } = options;
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

  const gateway = await createGateway({
    config,
    sendblue,
    pi,
    browser,
    tailscale,
  });
  const wsPath = browserWsPath(config);
  const proxies = new WeakMap<object, VncProxy>();

  const internal = Bun.serve({
    hostname: "127.0.0.1",
    port: internalPort,
    async fetch(request) {
      const result = await handleBrowserEnsure(request, browser);
      return new Response(result.body, { status: result.status, headers: result.headers });
    },
  });

  console.log(`pi-personal app ready; browser ensure on 127.0.0.1:${internal.port}`);

  return {
    gateway,
    wsPath,
    browser,
    async handleUpgrade(request, bunServer) {
      const url = new URL(request.url);
      if (!wsPath || url.pathname !== wsPath) return undefined;
      if (!browser.status().running) {
        return new Response("browser is not running", { status: 503 });
      }
      const headers = vncProtocolHeaders(request);
      if (bunServer.upgrade(request, headers ? { headers } : {})) return "upgraded";
      return new Response("upgrade failed", { status: 400 });
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
    async stop() {
      await browser.stop();
      await tailscale.stop();
      await pi.stop();
      internal.stop();
    },
  };
}
