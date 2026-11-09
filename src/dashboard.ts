import { spawn } from "node:child_process";
import type { Config } from "./config";
import {
  addHttpMcpServers,
  listMcpServersFrom,
  mcpConfigPaths,
  removeMcpServers,
  validateMcpName,
  validateMcpUrl,
  type ListedMcpServer,
} from "./mcp-config";
import type { PiAgent } from "./pi";
import type { GatewayResult } from "./result";

type DashboardOptions = {
  config: Config;
  pi: PiAgent;
};

export function dashboardPath(config: Pick<Config, "dashboardPathSecret">): string | undefined {
  if (!config.dashboardPathSecret) return undefined;
  return `/settings/${config.dashboardPathSecret}`;
}

export async function handleDashboard(
  request: Request,
  options: DashboardOptions,
): Promise<GatewayResult | undefined> {
  const path = dashboardPath(options.config);
  if (!path) return undefined;

  const url = new URL(request.url);
  if (url.pathname !== path) return undefined;

  if (request.method === "GET") {
    return render(options, url.searchParams.get("notice"), url.searchParams.get("error"));
  }
  if (request.method !== "POST") {
    return { status: 405, body: "method not allowed" };
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirect(path, undefined, "Could not read the form.");
  }

  const action = parseAction(String(form.get("action") ?? ""));
  if (!action) return redirect(path, undefined, "Unknown action.");

  switch (action) {
    case "add": {
      const name = String(form.get("name") ?? "");
      const mcpUrl = String(form.get("url") ?? "");
      const bearerToken = String(form.get("token") ?? "");
      const nameError = validateMcpName(name);
      if (nameError) return redirect(path, undefined, nameError);
      const urlError = validateMcpUrl(mcpUrl);
      if (urlError) return redirect(path, undefined, urlError);
      try {
        await addHttpMcpServers(configMcpPaths(options.config), {
          name,
          url: mcpUrl,
          bearerToken: bearerToken.trim() || undefined,
        });
        await options.pi.restart();
      } catch (error) {
        return redirect(path, undefined, error instanceof Error ? error.message : String(error));
      }
      return redirect(path, `Added ${name.trim()}. Pi will pick it up on the next text.`);
    }
    case "remove": {
      const name = String(form.get("name") ?? "");
      try {
        const removed = await removeMcpServers(configMcpPaths(options.config), name);
        if (!removed) return redirect(path, undefined, `No server named ${name}.`);
        await options.pi.restart();
      } catch (error) {
        return redirect(path, undefined, error instanceof Error ? error.message : String(error));
      }
      return redirect(path, `Removed ${name}.`);
    }
    default: {
      const _exhaustive: never = action;
      return redirect(path, undefined, `Unknown action: ${_exhaustive}`);
    }
  }
}

type DashboardAction = "add" | "remove";

function parseAction(value: string): DashboardAction | undefined {
  if (value === "add" || value === "remove") return value;
  return undefined;
}

function redirect(path: string, notice?: string, error?: string): GatewayResult {
  const next = new URL(path, "http://dashboard.local");
  if (notice) next.searchParams.set("notice", notice);
  if (error) next.searchParams.set("error", error);
  return {
    status: 303,
    body: "",
    headers: { Location: `${next.pathname}${next.search}` },
  };
}

async function render(
  options: DashboardOptions,
  notice: string | null,
  error: string | null,
): Promise<GatewayResult> {
  let servers: ListedMcpServer[] = [];
  let loadError = error;
  try {
    servers = await listMcpServersFrom(configMcpPaths(options.config));
  } catch (caught) {
    loadError = caught instanceof Error ? caught.message : String(caught);
  }

  const mcpStatus = await probePiMcp(options.config);

  return {
    status: 200,
    body: page(options.config, servers, notice, loadError, mcpStatus),
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  };
}

function page(
  config: Config,
  servers: ListedMcpServer[],
  notice: string | null,
  error: string | null,
  mcpStatus: string | undefined,
): string {
  const model = config.piModel ?? "Pi default";
  const provider = config.piProvider ?? "Pi default";
  const rows = servers.length
    ? servers.map((server) => serverRow(server)).join("")
    : `<tr><td colspan="4" class="empty">None configured. Paste your MCP URL below — Pi does not ship with any servers.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>pi-personal settings</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font: 16px/1.45 system-ui, sans-serif; padding: 24px; }
    main { max-width: 40rem; margin: 0 auto; }
    h1 { font-size: 1.4rem; margin: 0 0 0.4rem; }
    h2 { font-size: 1.05rem; margin: 2rem 0 0.6rem; }
    .lede, .hint { color: CanvasText; opacity: 0.72; }
    .flash { padding: 0.7rem 0.8rem; margin: 1rem 0; border: 1px solid; }
    .ok { border-color: #1f7a3a; }
    .bad { border-color: #a11; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; vertical-align: top; padding: 0.45rem 0.4rem 0.45rem 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
    .empty { opacity: 0.7; }
    form.stack { display: grid; gap: 0.7rem; }
    label { display: grid; gap: 0.25rem; font-size: 0.92rem; }
    input { font: inherit; padding: 0.45rem 0.5rem; }
    button { font: inherit; padding: 0.45rem 0.7rem; }
    code { font-size: 0.9em; }
    pre.status { white-space: pre-wrap; font-size: 0.82rem; padding: 0.7rem; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); overflow: auto; }
    .row-form { display: inline; }
  </style>
</head>
<body>
  <main>
    <h1>pi-personal settings</h1>
    <p class="lede">This page is on the Sprite, behind an unguessable URL. Do not share it. MCP tools talk to your server directly — there is no marketplace proxy.</p>
    ${notice ? `<p class="flash ok">${escapeHtml(notice)}</p>` : ""}
    ${error ? `<p class="flash bad">${escapeHtml(error)}</p>` : ""}

    <h2>Agent</h2>
    <table>
      <tr><th>Phone</th><td><code>${escapeHtml(config.allowedPhone)}</code></td></tr>
      <tr><th>Model</th><td><code>${escapeHtml(model)}</code></td></tr>
      <tr><th>Provider</th><td><code>${escapeHtml(provider)}</code></td></tr>
      <tr><th>Project MCP</th><td><code>${escapeHtml(config.mcpConfigPath)}</code></td></tr>
      <tr><th>User MCP</th><td><code>${escapeHtml(config.userMcpPath)}</code></td></tr>
    </table>
    <p class="hint">Model and phone come from <code>.env</code> on the Sprite. Change those there, then re-run <code>./scripts/provision.sh</code>. Pi always reads the user MCP file; the project file needs <code>--approve</code>.</p>

    <h2>MCP servers</h2>
    ${mcpStatus ? `<pre class="status">${escapeHtml(mcpStatus)}</pre>` : `<p class="hint">Could not run <code>pi mcp list</code> yet. After provision, this block shows whether Pi connected and which <code>mcp__*</code> tools it loaded.</p>`}
    <table>
      <thead><tr><th>Name</th><th>Target</th><th>Auth</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <h2>Add HTTP MCP</h2>
    <p class="hint">Paste the streamable HTTP URL (usually ending in <code>/mcp</code>). Saved to both MCP files with <code>exposure: direct</code> so tools are declared to the model. Optional bearer token stays on the Sprite, not in git.</p>
    <form class="stack" method="post">
      <input type="hidden" name="action" value="add">
      <label>Name
        <input name="name" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_-]*" placeholder="calendar">
      </label>
      <label>MCP URL
        <input name="url" required type="url" placeholder="https://example.com/mcp">
      </label>
      <label>Bearer token (optional)
        <input name="token" type="password" autocomplete="off">
      </label>
      <button type="submit">Add server</button>
    </form>
  </main>
</body>
</html>`;
}

function serverRow(server: ListedMcpServer): string {
  return `<tr>
    <td><code>${escapeHtml(server.name)}</code></td>
    <td><code>${escapeHtml(server.target)}</code></td>
    <td>${server.hasAuth ? "yes" : "no"}</td>
    <td>
      <form class="row-form" method="post">
        <input type="hidden" name="action" value="remove">
        <input type="hidden" name="name" value="${escapeHtml(server.name)}">
        <button type="submit">Remove</button>
      </form>
    </td>
  </tr>`;
}

function configMcpPaths(config: Pick<Config, "mcpConfigPath" | "userMcpPath">): string[] {
  return mcpConfigPaths(config.mcpConfigPath, config.userMcpPath);
}

async function probePiMcp(config: Config): Promise<string | undefined> {
  // Unit tests use a 1s agent timeout; skip the live Pi probe there.
  if (config.agentTimeoutMs <= 5_000) return undefined;
  return new Promise((resolve) => {
    const child = spawn(config.piCli, ["mcp", "list", "--approve"], {
      cwd: config.agentCwd,
      env: process.env,
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(redactMcpStatus(out) || undefined);
    }, 12_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(redactMcpStatus(out) || undefined);
    });
  });
}

function redactMcpStatus(value: string): string {
  return value
    .replace(/Bearer \S+/gi, "Bearer [redacted]")
    .replace(/Authorization:\s*.*/gi, "Authorization: [redacted]")
    .trim()
    .slice(-4000);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
