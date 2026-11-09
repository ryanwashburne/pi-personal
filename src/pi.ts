import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Config } from "./config";
import { isStopCommand } from "./stop-command";

type RpcResponse = {
  type: "response";
  id: string;
  success: boolean;
  data?: { text?: string; disposition?: string };
  error?: string;
};

export type PromptResult = { kind: "reply"; text: string } | { kind: "injected" };

export type PiAgent = {
  prompt: (message: string) => Promise<PromptResult>;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
};

type RunningTurn = {
  started: Promise<void>;
  finished: Promise<string>;
  suppressDeliver: boolean;
};

export const PI_RPC_TOOLS =
  "read,bash,edit,write,grep,find,ls,codemode,tool_search,fetch,mcp__*";

const RPC_ACK_TIMEOUT_MS = 30_000;

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
  let running: RunningTurn | undefined;

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

  function send(command: Record<string, unknown>, timeoutMs = RPC_ACK_TIMEOUT_MS): Promise<RpcResponse> {
    const proc = child;
    if (!proc?.stdin.writable) {
      return Promise.reject(new Error("pi RPC is not running"));
    }
    const id = `req_${++requestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for pi ${String(command.type)}`));
      }, timeoutMs);
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

  async function runPrompt(message: string, markStarted: () => void): Promise<string> {
    try {
      const accepted = await send({ type: "prompt", message });
      markStarted();
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
    } finally {
      markStarted();
    }
  }

  async function trySteer(message: string): Promise<boolean> {
    try {
      const steered = await send({ type: "steer", message });
      if (steered.success) return true;
    } catch (error) {
      console.warn("pi steer failed", error);
    }
    try {
      const queued = await send({ type: "prompt", message, streamingBehavior: "steer" });
      return queued.success && queued.data?.disposition === "queued";
    } catch (error) {
      console.warn("pi prompt steer failed", error);
      return false;
    }
  }

  async function finalize(turn: RunningTurn): Promise<PromptResult> {
    try {
      const text = await turn.finished;
      if (turn.suppressDeliver) return { kind: "injected" };
      return { kind: "reply", text };
    } catch (error) {
      if (turn.suppressDeliver) return { kind: "injected" };
      throw error;
    } finally {
      if (running === turn) running = undefined;
    }
  }

  function startTurn(message: string): Promise<PromptResult> {
    if (running) return dispatch(message);
    let started = false;
    let markStarted = () => {};
    const startedP = new Promise<void>((resolve) => {
      markStarted = () => {
        if (started) return;
        started = true;
        resolve();
      };
    });
    const turn: RunningTurn = {
      started: startedP,
      finished: Promise.resolve(""),
      suppressDeliver: false,
    };
    running = turn;
    turn.finished = runPrompt(message, markStarted);
    return finalize(turn);
  }

  async function dispatch(message: string): Promise<PromptResult> {
    const current = running;
    if (!current) return startTurn(message);
    await current.started.catch(() => {});
    if (isStopCommand(message)) {
      current.suppressDeliver = true;
      try {
        await send({ type: "abort" }, config.agentTimeoutMs);
      } catch (error) {
        console.warn("pi abort failed", error);
      }
      await current.finished.catch(() => {});
      return dispatch(message);
    }
    if (await trySteer(message)) {
      await current.finished.catch(() => {});
      return { kind: "injected" };
    }
    await current.finished.catch(() => {});
    return dispatch(message);
  }

  async function prompt(message: string): Promise<PromptResult> {
    await ensureStarted();
    return dispatch(message);
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
    prompt,
    restart: stop,
    stop,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
