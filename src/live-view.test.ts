import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  liveViewFilePath,
  liveViewPromptNote,
  normalizeOrigin,
  originFromHeaders,
  promptWithLiveView,
  renderLiveViewMarkdown,
  resolveLiveView,
  syncLiveViewFile,
} from "./live-view";

test("normalizeOrigin strips a trailing slash", () => {
  expect(normalizeOrigin("https://abc.sprites.app/")).toBe("https://abc.sprites.app");
});

test("originFromHeaders only accepts sprites.app hosts", () => {
  expect(
    originFromHeaders(new Headers({ host: "localhost:8080", "x-forwarded-proto": "https" })),
  ).toBeUndefined();
  expect(
    originFromHeaders(
      new Headers({
        "x-forwarded-host": "abc.sprites.app",
        "x-forwarded-proto": "https",
      }),
    ),
  ).toBe("https://abc.sprites.app");
});

test("SPRITE_URL wins over a forwarded host", () => {
  const links = resolveLiveView(
    {
      dashboardPathSecret: "dash-secret",
      spriteUrl: "https://from-env.sprites.app/",
    },
    new Headers({ "x-forwarded-host": "from-request.sprites.app" }),
  );
  expect(links.liveViewUrl).toBe("https://from-env.sprites.app/settings/dash-secret/browser");
  expect(links.settingsUrl).toBe("https://from-env.sprites.app/settings/dash-secret");
});

test("forwarded sprites.app host fills the URL when SPRITE_URL is missing", () => {
  const links = resolveLiveView(
    { dashboardPathSecret: "dash-secret", spriteUrl: undefined },
    new Headers({ "x-forwarded-host": "learned.sprites.app" }),
  );
  expect(links.liveViewUrl).toBe("https://learned.sprites.app/settings/dash-secret/browser");
});

test("renderLiveViewMarkdown covers off / unknown / ready", () => {
  expect(renderLiveViewMarkdown({ dashboardEnabled: false })).toContain("Dashboard is off");
  expect(renderLiveViewMarkdown({ dashboardEnabled: true })).toContain("unknown");
  expect(
    renderLiveViewMarkdown({
      dashboardEnabled: true,
      liveViewUrl: "https://abc.sprites.app/settings/s/browser",
      settingsUrl: "https://abc.sprites.app/settings/s",
    }),
  ).toContain("https://abc.sprites.app/settings/s/browser");
});

test("syncLiveViewFile writes the guide into the agent cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-live-view-"));
  const links = syncLiveViewFile({
    agentCwd: dir,
    dashboardPathSecret: "dash-secret",
    spriteUrl: "https://abc.sprites.app",
  });
  expect(readFileSync(liveViewFilePath(dir), "utf8")).toBe(links.markdown);
  expect(links.markdown).toContain(links.liveViewUrl ?? "missing");
});

test("promptWithLiveView prefixes only when a URL exists", () => {
  expect(promptWithLiveView("hello", undefined)).toBe("hello");
  expect(promptWithLiveView("hello", "https://abc.sprites.app/settings/s/browser")).toBe(
    `${liveViewPromptNote("https://abc.sprites.app/settings/s/browser")}\n\nhello`,
  );
});
