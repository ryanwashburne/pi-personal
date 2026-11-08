import { loadConfig } from "./config";
import { createPiAgent } from "./pi";
import { createSendblueClient } from "./sendblue";
import { createGateway } from "./webhook";

const config = loadConfig();
const pi = createPiAgent(config);
const gateway = await createGateway({
  config,
  sendblue: createSendblueClient(config),
  pi,
});

const server = Bun.serve({
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    const result = await gateway.handle(request);
    console.log(`${request.method} ${url.pathname} -> ${result.status} ${result.body}`);
    if (result.work) {
      void result.work().catch((error) => console.error("background work failed", error));
    }
    return new Response(result.body, { status: result.status });
  },
});

console.log(`pi-personal listening on :${server.port}`);

process.on("SIGTERM", () => {
  void pi.stop().finally(() => process.exit(0));
});
