import { attachVncWebSocket, toBuffer, type VncProxy } from "./vnc-proxy";
import { createBrowserSession } from "./browser-session";
import { loadConfig } from "./config";
import { browserWsPath } from "./dashboard";
import { createPiAgent } from "./pi";
import { createSendblueClient } from "./sendblue";
import { createGateway } from "./webhook";

const proxies = new WeakMap<object, VncProxy>();

const config = loadConfig();
const pi = createPiAgent(config);
const browser = createBrowserSession({ agentCwd: config.agentCwd });
const gateway = await createGateway({
  config,
  sendblue: createSendblueClient(config),
  pi,
  browser,
});
const wsPath = browserWsPath(config);

const server = Bun.serve({
  port: config.port,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    if (wsPath && url.pathname === wsPath) {
      if (!browser.status().running) {
        return new Response("browser is not running", { status: 503 });
      }
      if (bunServer.upgrade(request)) return;
      return new Response("upgrade failed", { status: 400 });
    }

    const result = await gateway.handle(request);
    const summary = result.headers?.["content-type"]?.includes("text/html")
      ? `html ${result.body.length}b`
      : result.body;
    console.log(`${request.method} ${url.pathname} -> ${result.status} ${summary}`);
    // Await the turn while the webhook connection is still open. That HTTP
    // activity is what keeps a Sprite from sleeping; a background promise does not.
    if (result.work) {
      try {
        await result.work();
      } catch (error) {
        console.error("agent work failed", error);
      }
    }
    return new Response(result.body, { status: result.status, headers: result.headers });
  },
  websocket: {
    idleTimeout: 600,
    async open(ws) {
      try {
        const proxy = await attachVncWebSocket(
          {
            send(data) {
              ws.send(data);
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

console.log(`pi-personal listening on :${server.port}`);

process.on("SIGTERM", () => {
  void (async () => {
    await browser.stop();
    await pi.stop();
    process.exit(0);
  })();
});
