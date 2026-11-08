import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX = 400;

export type Dedupe = {
  seen: (id: string) => boolean;
  remember: (id: string) => Promise<void>;
};

export async function createDedupe(path: string): Promise<Dedupe> {
  const ids = new Set(await readIds(path));

  return {
    seen(id) {
      return ids.has(id);
    },
    async remember(id) {
      if (ids.has(id)) return;
      ids.add(id);
      const list = [...ids];
      if (list.length > MAX) {
        const extra = list.length - MAX;
        for (const old of list.slice(0, extra)) ids.delete(old);
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify([...ids], null, 2));
    },
  };
}

async function readIds(path: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}
