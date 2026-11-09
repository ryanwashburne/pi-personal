import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Config } from "./config";

type RpcResponse = {
  type: "response";
  id: string;
  success: boolean;
  data?: { text?: string; disposition?: string };
  error?: string;
};

export type PiAgent = {
  prompt: (message: string) => Promise<string>;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
};

export const PI_RPC_TOOLS = "read,bash,edit,write,grep,find,ls,codemode,tool_search,mcp__*";

export function createPiAgent(config: Config): PiAgent {
  let child: ChildProcessWithoutNullStreams | undefined;
  let buffer = "";
  let requestId = 0;
  const pending = new Map<
    string,
    { resolve: (value: RpcResponse) => void; reject: (error: Error) => void }
  >();
  const idleWaiters = new Set<() => void>();
  let starting: Promise<void> | undefined;
  let busy = false;
  const queue: Array<{ message: string; resolve: (text: string) => void; reject: (error: Error) => void }> =
    [];

  function ensureStarted(): Promise<void> {
    if (child && child.exitCode === null) return Promise.resolve();
    if (starting) return starting;
    starting = start();
    return starting;
  }

  async function start() {
    mkdirSync(config.sessionDir, { recursive: true });
    mkdirSync(config.agentCwd, { recursive: true });

    const args = [
      "--mode",
      "rpc",
      "--session-dir",
      config.sessionDir,
      "--session-id",
      "imessage",
      "--approve",
      "--name",
      "imessage",
      "--system-prompt",
      `${config.agentCwd}/SYSTEM.md`,
      "--tools",
      PI_RPC_TOOLS,
    ];
    if (config.piProvider) args.push("--provider", config.piProvider);
    if (config.piModel) args.push("--model", config.piModel);

    child = spawn(config.piCli, args, {
      cwd: config.agentCwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    buffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handleLine(line);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      process.stderr.write(chunk);
    });
    child.on("exit", (code, signal) => {
      const error = new Error(`pi exited (code=${code} signal=${signal})`);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      child = undefined;
      starting = undefined;
    });

    await delay(150);
    if (!child || child.exitCode !== null) {
      throw new Error("pi failed to start in RPC mode. Is PI_CLI installed and authenticated?");
    }
  }

  function handleLine(line: string) {
    let parsed: { type?: string; id?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed.type === "response" && parsed.id && pending.has(parsed.id)) {
      const waiter = pending.get(parsed.id);
      pending.delete(parsed.id);
      waiter?.resolve(parsed as RpcResponse);
      return;
    }
    if (parsed.type === "agent_settled") {
      for (const notify of idleWaiters) notify();
      idleWaiters.clear();
    }
  }

  function send(command: Record<string, unknown>): Promise<RpcResponse> {
    const proc = child;
    if (!proc?.stdin.writable) {
      return Promise.reject(new Error("pi RPC is not running"));
    }
    const id = `req_${++requestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for pi ${String(command.type)}`));
      }, 30_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  function waitForIdle(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        idleWaiters.delete(notify);
        reject(new Error(`pi timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const notify = () => {
        clearTimeout(timer);
        resolve();
      };
      idleWaiters.add(notify);
    });
  }

  async function runPrompt(message: string): Promise<string> {
    await ensureStarted();
    const accepted = await send({ type: "prompt", message });
    if (!accepted.success) {
      throw new Error(accepted.error ?? "pi rejected prompt");
    }
    if (accepted.data?.disposition !== "handled") {
      await waitForIdle(config.agentTimeoutMs);
    }
    const text = await send({ type: "get_last_assistant_text" });
    if (!text.success) {
      throw new Error(text.error ?? "pi did not return assistant text");
    }
    return text.data?.text?.trim() || "I finished, but I don't have a text reply.";
  }

  function enqueue(message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      queue.push({ message, resolve, reject });
      void drain();
    });
  }

  async function drain() {
    if (busy) return;
    const next = queue.shift();
    if (!next) return;
    busy = true;
    try {
      next.resolve(await runPrompt(next.message));
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      busy = false;
      void drain();
    }
  }

  async function stop() {
    const proc = child;
    child = undefined;
    starting = undefined;
    if (!proc) return;
    proc.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
      }),
      delay(2000),
    ]);
  }

  return {
    prompt: enqueue,
    restart: stop,
    stop,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
