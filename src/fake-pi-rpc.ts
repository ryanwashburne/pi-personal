#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const cwd = process.cwd();
const logPath = join(cwd, "fake-pi-rpc.log");
const delayPath = join(cwd, "fake-pi-delay-ms");
const delayMs = existsSync(delayPath) ? Number(readFileSync(delayPath, "utf8")) : 250;

let streaming = false;
let lastText = "";
const steers: string[] = [];
let settleTimer: ReturnType<typeof setTimeout> | undefined;

function emit(payload: unknown) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function log(entry: unknown) {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function settle() {
  streaming = false;
  settleTimer = undefined;
  if (steers.length) {
    lastText = `${lastText} steered:${steers.join(",")}`.trim();
    steers.length = 0;
  }
  emit({ type: "agent_settled" });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let cmd: { type?: string; id?: string; message?: string; streamingBehavior?: string };
  try {
    cmd = JSON.parse(trimmed) as typeof cmd;
  } catch {
    return;
  }

  log({
    type: cmd.type,
    message: cmd.message,
    streamingBehavior: cmd.streamingBehavior,
  });

  if (cmd.type === "prompt") {
    if (streaming && cmd.streamingBehavior === "steer") {
      if (cmd.message) steers.push(cmd.message);
      emit({ type: "response", id: cmd.id, success: true, data: { disposition: "queued" } });
      return;
    }
    if (streaming) {
      emit({ type: "response", id: cmd.id, success: false, error: "already streaming" });
      return;
    }
    streaming = true;
    lastText = `done:${cmd.message ?? ""}`;
    emit({ type: "response", id: cmd.id, success: true, data: { disposition: "started" } });
    settleTimer = setTimeout(settle, delayMs);
    return;
  }

  if (cmd.type === "steer") {
    if (!streaming) {
      emit({ type: "response", id: cmd.id, success: false, error: "not streaming" });
      return;
    }
    if (cmd.message) steers.push(cmd.message);
    emit({ type: "response", id: cmd.id, success: true, data: { disposition: "queued" } });
    return;
  }

  if (cmd.type === "abort") {
    if (settleTimer) clearTimeout(settleTimer);
    lastText = "aborted";
    steers.length = 0;
    settle();
    emit({ type: "response", id: cmd.id, success: true });
    return;
  }

  if (cmd.type === "get_last_assistant_text") {
    emit({ type: "response", id: cmd.id, success: true, data: { text: lastText } });
    return;
  }

  emit({ type: "response", id: cmd.id, success: false, error: `unknown ${cmd.type}` });
});
