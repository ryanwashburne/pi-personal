import { loadConfig } from "./config";
import { createFetchHandler, type EarlyGateway } from "./early-typing";
import { createSendblueClient } from "./sendblue";

const config = loadConfig();
const sendblue = createSendblueClient(config);
// Account-level. Sendblue already decided auto-typing for the inbound that
// woke this process; this call cannot cover that window. It only arms the
// *next* inbound if provision never ran.
void sendblue.enableAutoTyping?.().catch((error) => {
  console.warn("auto typing failed", error);
});

type WsSink = {
  send: (data: string | Uint8Array) => void;
  close: () => void;
};

type LoadedApp = {
  gateway: EarlyGateway;
  handleUpgrade: (
    request: Request,
    bunServer: { upgrade: (request: Request, options?: { headers?: HeadersInit }) => boolean },
  ) => Promise<"upgraded" | Response | undefined>;
  websocket: {
    open: (ws: WsSink) => Promise<void>;
    message: (ws: WsSink, message: string | Buffer | Uint8Array) => void;
    close: (ws: WsSink) => void;
  };
  stop: () => Promise<void>;
};

let resolveApp: (app: LoadedApp) => void = () => {};
const appPromise = new Promise<LoadedApp>((resolve) => {
  resolveApp = resolve;
});

const handleHttp = createFetchHandler({
  config,
  sendblue,
  gateway: appPromise.then((app) => app.gateway),
});

const server = Bun.serve({
  port: config.port,
  async fetch(request, bunServer) {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const app = await appPromise;
      const upgraded = await app.handleUpgrade(request, bunServer);
      if (upgraded === "upgraded") return;
      if (upgraded) return upgraded;
    }
    return handleHttp(request);
  },
  websocket: {
    idleTimeout: 600,
    async open(ws) {
      const app = await appPromise;
      await app.websocket.open(ws);
    },
    message(ws, message) {
      void appPromise.then((app) => app.websocket.message(ws, message));
    },
    close(ws) {
      void appPromise.then((app) => app.websocket.close(ws)).catch(() => undefined);
    },
  },
});

console.log(`pi-personal listening on :${server.port}`);

// Bind first so Fly can deliver the webhook as soon as this process exists.
// That is after warmup. Warmup “…” is Sendblue auto-typing from provision —
// this process is not running yet (cold) or was frozen (warm).
void import("./app")
  .then((mod) => mod.startApp({ config, sendblue }))
  .then((app) => resolveApp(app))
  .catch((error) => {
    console.error("gateway init failed", error);
    process.exit(1);
  });

process.on("SIGTERM", () => {
  void (async () => {
    const app = await appPromise.catch(() => undefined);
    await app?.stop();
    server.stop();
    process.exit(0);
  })();
});
