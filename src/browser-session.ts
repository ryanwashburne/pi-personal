import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { holdSprite, type Hold } from "./tasks";

const CHROME_NAMES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
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
  exitNode?: string;
  proxy?: string;
};

export type BrowserStartOptions = {
  hold?: boolean;
};

export type BrowserSession = {
  status: () => BrowserStatus;
  start: (options?: BrowserStartOptions) => Promise<void>;
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
  requireProxy?: boolean;
  ensureNetwork?: () => Promise<{ proxyUrl?: string; exitNode?: string } | void>;
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
  let died: string | undefined;
  const logs: string[] = [];
  const children: ChildProcess[] = [];
  let hold: Hold | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let network: { proxyUrl?: string; exitNode?: string } = {};
  let startChain = Promise.resolve();

  function resolveChrome(): string | undefined {
    return chromePath(which, [join(process.cwd(), "browser-bin"), join(options.agentCwd, "browser-bin")]);
  }

  function missing(): string[] {
    const needed: string[] = [];
    if (!which("Xvfb")) needed.push("Xvfb");
    if (!which("x11vnc")) needed.push("x11vnc");
    if (!resolveChrome()) needed.push("chromium");
    return needed;
  }

  function status(): BrowserStatus {
    return {
      running,
      profileDir,
      missing: missing(),
      error,
      exitNode: network.exitNode,
      proxy: network.proxyUrl,
    };
  }

  async function acquireHold() {
    if (hold) return;
    hold = await holdFn().catch((caught) => {
      console.warn("browser task hold failed", caught);
      return undefined;
    });
    if (!hold || heartbeat) return;
    heartbeat = setInterval(() => {
      void hold?.heartbeat().catch((caught) => console.warn("browser hold heartbeat failed", caught));
    }, 60_000);
    heartbeat.unref();
  }

  async function start(startOptions?: BrowserStartOptions) {
    const run = startChain.then(() => startUnlocked(startOptions));
    startChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function startUnlocked(startOptions?: BrowserStartOptions) {
    const wantHold = startOptions?.hold !== false;
    if (running) {
      if (wantHold) await acquireHold();
      return;
    }
    const absent = missing();
    if (absent.length > 0) {
      const stub = stubChrome(which);
      error = `Missing ${absent.join(", ")}. Re-run ./scripts/provision.sh on the Sprite.`;
      if (stub) {
        error = `${error} ${stub} is Ubuntu's snap wrapper, not a real browser.`;
      }
      throw new Error(error);
    }

    mkdirSync(profileDir, { recursive: true });
    error = undefined;
    died = undefined;
    logs.length = 0;
    network = (await options.ensureNetwork?.()) ?? {};
    if (options.requireProxy && !network.proxyUrl) {
      error = "Tailscale SOCKS proxy is not up. Set TAILSCALE_AUTHKEY and TAILSCALE_EXIT_NODE, then Start again.";
      throw new Error(error);
    }

    const throwIfDied = () => {
      if (died) throw new Error(died);
    };

    try {
      const xvfb = which("Xvfb");
      const vnc = which("x11vnc");
      if (!xvfb || !vnc) throw new Error("Xvfb or x11vnc disappeared after the dependency check.");

      children.push(
        watchExit(
          track(
            spawnChild(
              xvfb,
              [BROWSER_DISPLAY, "-ac", "-screen", "0", `${BROWSER_WIDTH}x${BROWSER_HEIGHT}x24`, "-nolisten", "tcp"],
              { stdio: ["ignore", "pipe", "pipe"] },
            ),
            logs,
          ),
          "Xvfb",
        ),
      );
      await delay(options.readyDelayMs ?? 400);

      const displayEnv = {
        ...process.env,
        DISPLAY: BROWSER_DISPLAY,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/tmp",
        LIBGL_ALWAYS_SOFTWARE: "1",
      };

      const xsetroot = which("xsetroot");
      if (xsetroot) {
        track(
          spawnChild(xsetroot, ["-solid", "#5b87b0"], { stdio: ["ignore", "pipe", "pipe"], env: displayEnv }),
          logs,
        );
      }

      const wm = which("openbox") || which("fluxbox") || which("matchbox-window-manager");
      if (wm) {
        children.push(
          watchExit(
            track(spawnChild(wm, [], { stdio: ["ignore", "pipe", "pipe"], env: displayEnv }), logs),
            "window-manager",
          ),
        );
        await delay(options.readyDelayMs ?? 400);
      }

      children.push(
        watchExit(
          track(
            spawnChild(
              vnc,
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
                "-xkb",
                "-noxdamage",
                "-cursor",
                "arrow",
              ],
              { stdio: ["ignore", "pipe", "pipe"], env: displayEnv },
            ),
            logs,
          ),
          "x11vnc",
        ),
      );
      await waitForPort(BROWSER_VNC_PORT, 8_000);
      throwIfDied();

      const chrome = resolveChrome();
      if (!chrome) throw new Error("chromium disappeared after the dependency check.");
      const homePage = join(profileDir, "home.html");
      writeFileSync(
        homePage,
        `<!doctype html><meta charset="utf-8"><title>Sprite browser</title>
<body style="margin:0;font:20px/1.4 system-ui,sans-serif;background:#dce6f2;color:#123;padding:48px">
<h1>Sprite Chromium</h1>
<p>This is the browser on the Sprite. Type a URL in the address bar and log in here.</p>
<p>Egress: ${network.exitNode ? `Tailscale exit node ${network.exitNode}` : "Sprite / Fly IP"}.</p>
<p>Check the public IP: <a href="https://ifconfig.me">ifconfig.me</a></p>
</body>`,
      );
      const chromeArgs = [
        `--user-data-dir=${profileDir}`,
        `--window-size=${BROWSER_WIDTH},${BROWSER_HEIGHT}`,
        `--window-position=0,0`,
        `--remote-debugging-port=${BROWSER_CDP_PORT}`,
        "--remote-debugging-address=127.0.0.1",
        "--ozone-platform=x11",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--test-type",
        "--disable-dev-shm-usage",
        "--start-maximized",
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "--hide-crash-restore-bubble",
      ];
      if (network.proxyUrl) {
        chromeArgs.push(`--proxy-server=${network.proxyUrl}`, "--proxy-bypass-list=<-loopback>");
      }
      chromeArgs.push(`file://${homePage}`);
      children.push(
        watchExit(
          track(
            spawnChild(
              chrome,
              chromeArgs,
              {
                stdio: ["ignore", "pipe", "pipe"],
                env: {
                  ...displayEnv,
                  DBUS_SESSION_BUS_ADDRESS: "unix:path=/dev/null",
                },
              },
            ),
            logs,
          ),
          "chromium",
        ),
      );
      await delay(options.readyDelayMs ?? 400);
      throwIfDied();
      try {
        await waitForPort(BROWSER_CDP_PORT, 15_000);
      } catch (caught) {
        throwIfDied();
        throw caught;
      }
      throwIfDied();

      running = true;
      if (wantHold) await acquireHold();
    } catch (caught) {
      const fail = caught instanceof Error ? caught.message : String(caught);
      error = logs.length > 0 ? `${fail}\n${logs.join("").slice(-2000)}` : fail;
      stopping = true;
      await stopChildren(children);
      children.length = 0;
      running = false;
      stopping = false;
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
      const message = `${label} exited (code=${code})`;
      const detail = logs.length > 0 ? `${message}\n${logs.join("").slice(-2000)}` : message;
      if (stopping) return;
      error = detail;
      if (!running) {
        died = detail;
        return;
      }
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

function stubChrome(which: WhichFn): string | undefined {
  for (const name of CHROME_NAMES) {
    const path = which(name);
    if (path && isSnapStub(path)) return path;
  }
  return undefined;
}

function chromePath(which: WhichFn, searchRoots: string[]): string | undefined {
  const fromEnv = process.env.CHROME_BIN;
  if (fromEnv && existsSync(fromEnv) && !isSnapStub(fromEnv)) return fromEnv;
  for (const name of CHROME_NAMES) {
    const path = which(name);
    if (path && !isSnapStub(path)) return path;
  }
  for (const root of searchRoots) {
    const found = findNamedExecutable(root, ["chrome", "google-chrome", "chromium"]);
    if (found && !isSnapStub(found)) return found;
  }
  return undefined;
}

export function isSnapStub(path: string): boolean {
  if (path.includes("/snap/")) return true;
  try {
    const buf = readFileSync(path).subarray(0, 4096);
    if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
      return false;
    }
    return /requires the chromium snap|snap install chromium/i.test(buf.toString("utf8"));
  } catch {
    return false;
  }
}

function findNamedExecutable(root: string, names: string[], depth = 0): string | undefined {
  if (depth > 6 || !existsSync(root)) return undefined;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && names.includes(entry.name)) return path;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findNamedExecutable(join(root, entry.name), names, depth + 1);
    if (found) return found;
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
