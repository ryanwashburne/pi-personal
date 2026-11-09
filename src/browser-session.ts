import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { holdSprite, type Hold } from "./tasks";

const CHROME_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "chrome",
];

export const BROWSER_DISPLAY = ":99";
export const BROWSER_VNC_PORT = 5900;
export const BROWSER_CDP_PORT = 9222;
export const BROWSER_WIDTH = 1280;
export const BROWSER_HEIGHT = 800;

export type BrowserStatus = {
  running: boolean;
  profileDir: string;
  missing: string[];
  error?: string;
};

export type BrowserSession = {
  status: () => BrowserStatus;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  vncPort: () => number;
};

type SpawnFn = (command: string, args: string[], options?: Parameters<typeof spawn>[2]) => ChildProcess;
type WhichFn = (name: string) => string | null;

export type BrowserSessionOptions = {
  agentCwd: string;
  hold?: () => Promise<Hold>;
  spawn?: SpawnFn;
  which?: WhichFn;
  waitForPort?: (port: number, timeoutMs: number) => Promise<void>;
  readyDelayMs?: number;
};

export function browserProfileDir(agentCwd: string): string {
  return join(agentCwd, "browser-profile");
}

export function createBrowserSession(options: BrowserSessionOptions): BrowserSession {
  const profileDir = browserProfileDir(options.agentCwd);
  const spawnChild = options.spawn ?? spawn;
  const which = options.which ?? whichBinary;
  const waitForPort = options.waitForPort ?? waitForTcpPort;
  const holdFn = options.hold ?? (() => holdSprite("browser"));

  let running = false;
  let stopping = false;
  let error: string | undefined;
  const children: ChildProcess[] = [];
  let hold: Hold | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function missing(): string[] {
    const needed: string[] = [];
    if (!which("Xvfb")) needed.push("Xvfb");
    if (!which("x11vnc")) needed.push("x11vnc");
    if (!chromePath(which)) needed.push("chromium");
    return needed;
  }

  function status(): BrowserStatus {
    return {
      running,
      profileDir,
      missing: missing(),
      error,
    };
  }

  async function start() {
    if (running) return;
    const absent = missing();
    if (absent.length > 0) {
      error = `Missing ${absent.join(", ")}. Re-run ./scripts/provision.sh on the Sprite.`;
      throw new Error(error);
    }

    mkdirSync(profileDir, { recursive: true });
    error = undefined;
    const logs: string[] = [];

    try {
      children.push(
        watchExit(
          track(
            spawnChild("Xvfb", [BROWSER_DISPLAY, "-screen", "0", `${BROWSER_WIDTH}x${BROWSER_HEIGHT}x24`, "-nolisten", "tcp"], {
              stdio: ["ignore", "pipe", "pipe"],
            }),
            logs,
          ),
          "Xvfb",
        ),
      );
      await delay(options.readyDelayMs ?? 250);

      children.push(
        watchExit(
          track(
            spawnChild(
              "x11vnc",
              [
                "-display",
                BROWSER_DISPLAY,
                "-rfbport",
                String(BROWSER_VNC_PORT),
                "-localhost",
                "-nopw",
                "-forever",
                "-shared",
                "-repeat",
                "-noxdamage",
              ],
              { stdio: ["ignore", "pipe", "pipe"] },
            ),
            logs,
          ),
          "x11vnc",
        ),
      );
      await waitForPort(BROWSER_VNC_PORT, 8_000);

      const chrome = chromePath(which);
      if (!chrome) throw new Error("chromium disappeared after the dependency check.");
      children.push(
        watchExit(
          track(
            spawnChild(
              chrome,
              [
                `--user-data-dir=${profileDir}`,
                `--window-size=${BROWSER_WIDTH},${BROWSER_HEIGHT}`,
                `--remote-debugging-port=${BROWSER_CDP_PORT}`,
                "--remote-debugging-address=127.0.0.1",
                "--no-sandbox",
                "--test-type",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--password-store=basic",
                "--hide-crash-restore-bubble",
                "about:blank",
              ],
              {
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env, DISPLAY: BROWSER_DISPLAY },
              },
            ),
            logs,
          ),
          "chromium",
        ),
      );

      running = true;
      hold = await holdFn().catch((caught) => {
        console.warn("browser task hold failed", caught);
        return undefined;
      });
      heartbeat = setInterval(() => {
        void hold?.heartbeat().catch((caught) => console.warn("browser hold heartbeat failed", caught));
      }, 60_000);
      heartbeat.unref();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      if (logs.length > 0) error = `${error}\n${logs.join("").slice(-1500)}`;
      await stopChildren(children);
      children.length = 0;
      running = false;
      throw new Error(error);
    }
  }

  async function stop() {
    stopping = true;
    running = false;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (hold) {
      await hold.release().catch((caught) => console.warn("browser hold release failed", caught));
      hold = undefined;
    }
    await stopChildren(children);
    children.length = 0;
    stopping = false;
  }

  function watchExit(child: ChildProcess, label: string): ChildProcess {
    child.on("exit", (code) => {
      if (!running || stopping) return;
      error = `${label} exited (code=${code})`;
      void stop();
    });
    return child;
  }

  return {
    status,
    start,
    stop,
    vncPort: () => BROWSER_VNC_PORT,
  };
}

function chromePath(which: WhichFn): string | undefined {
  for (const name of CHROME_NAMES) {
    const path = which(name);
    if (path) return path;
  }
  return undefined;
}

function whichBinary(name: string): string | null {
  return Bun.which(name) ?? null;
}

function track(child: ChildProcess, logs: string[]): ChildProcess {
  const append = (chunk: string) => {
    logs.push(chunk);
    if (logs.join("").length > 8_000) logs.splice(0, logs.length - 4);
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => append(chunk));
  child.stderr?.on("data", (chunk: string) => append(chunk));
  child.on("error", (err) => append(`${err.message}\n`));
  return child;
}

async function stopChildren(children: ChildProcess[]) {
  for (const child of [...children].reverse()) {
    if (child.exitCode !== null) continue;
    child.kill("SIGTERM");
  }
  await delay(400);
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

export function waitForTcpPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`timed out waiting for 127.0.0.1:${port}`));
          return;
        }
        setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
