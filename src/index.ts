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
});

console.log(`pi-personal listening on :${server.port}`);

process.on("SIGTERM", () => {
  void pi.stop().finally(() => process.exit(0));
});
