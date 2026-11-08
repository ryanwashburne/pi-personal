import { existsSync } from "node:fs";

const SOCKET = "/.sprite/api.sock";

export type Hold = {
  heartbeat: () => Promise<void>;
  release: () => Promise<void>;
};

export async function holdSprite(name = "agent"): Promise<Hold> {
  if (!existsSync(SOCKET)) {
    return {
      async heartbeat() {},
      async release() {},
    };
  }

  await spriteRequest("PUT", `/v1/tasks/${name}`, { expire: "5m" }).catch(async () => {
    await spriteRequest("POST", "/v1/tasks", { name, expire: "5m" });
  });

  return {
    async heartbeat() {
      await spriteRequest("PUT", `/v1/tasks/${name}`, { expire: "5m" });
    },
    async release() {
      await spriteRequest("DELETE", `/v1/tasks/${name}`);
    },
  };
}

async function spriteRequest(method: string, path: string, body?: Record<string, string>) {
  const args = [
    "curl",
    "-sS",
    "-o",
    "/tmp/pi-personal-task-body",
    "-w",
    "%{http_code}",
    "--unix-socket",
    SOCKET,
    "-X",
    method,
    `http://sprite${path}`,
  ];
  if (body) {
    args.push("-H", "Content-Type: application/json", "-d", JSON.stringify(body));
  }

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`sprite ${method} ${path} failed: ${stderr || stdout}`);
  }
  const status = Number(stdout.trim());
  if (status >= 400 && status !== 404) {
    throw new Error(`sprite ${method} ${path} failed: ${status}`);
  }
}
