import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_TOKEN_URL,
  completeGoogleOAuth,
  disconnectGoogleOAuth,
  ensureGoogleAccessToken,
  startGoogleOAuth,
  writeGoogleTokens,
  type GoogleOAuthClient,
} from "./google-oauth";

async function client(): Promise<GoogleOAuthClient & { dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "google-oauth-"));
  return {
    dir,
    clientId: "client.apps.googleusercontent.com",
    clientSecret: "client-secret",
    tokenPath: join(dir, "google-oauth.json"),
    pendingPath: join(dir, "google-oauth-pending.json"),
    now: () => 1_700_000_000_000,
  };
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      access_token: "ya29.access",
      refresh_token: "1//refresh",
      expires_in: 3600,
      token_type: "Bearer",
      scope: GOOGLE_OAUTH_SCOPES.join(" "),
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("authorize URL asks for offline access, PKCE, and Workspace scopes", async () => {
  const oauth = await client();
  const started = await startGoogleOAuth(oauth, "https://abc.sprites.app/settings/dash/google/callback");
  const url = new URL(started.authorizeUrl);
  expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
  expect(url.searchParams.get("client_id")).toBe(oauth.clientId);
  expect(url.searchParams.get("redirect_uri")).toBe("https://abc.sprites.app/settings/dash/google/callback");
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("prompt")).toBe("consent");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
  expect(url.searchParams.get("scope")).toContain("gmail.readonly");
  expect(url.searchParams.get("scope")).toContain("calendar.events");
  expect(url.searchParams.get("scope")).toContain("drive.file");
  const pending = JSON.parse(await readFile(join(oauth.dir, "google-oauth-pending.json"), "utf8")) as {
    state: string;
  };
  expect(pending.state).toBe(url.searchParams.get("state") ?? "");
});

test("callback exchanges the code and stores tokens", async () => {
  const oauth = await client();
  const posts: Array<{ url: string; body: string }> = [];
  oauth.fetchImpl = async (input, init) => {
    posts.push({ url: String(input), body: String(init?.body) });
    return tokenResponse();
  };
  const started = await startGoogleOAuth(oauth, "https://abc.sprites.app/settings/dash/google/callback");
  const tokens = await completeGoogleOAuth(oauth, {
    code: "auth-code",
    state: started.pending.state,
  });
  expect(tokens.accessToken).toBe("ya29.access");
  expect(tokens.refreshToken).toBe("1//refresh");
  expect(tokens.expiresAt).toBe(1_700_000_000_000 + 3_600_000);
  expect(posts).toHaveLength(1);
  expect(posts[0]?.url).toBe(GOOGLE_TOKEN_URL);
  expect(posts[0]?.body).toContain("grant_type=authorization_code");
  expect(posts[0]?.body).toContain("code=auth-code");
  expect(posts[0]?.body).toContain("code_verifier=");
  expect(await ensureGoogleAccessToken(oauth)).toBe("ya29.access");
});

test("callback rejects a mismatched state", async () => {
  const oauth = await client();
  await startGoogleOAuth(oauth, "https://abc.sprites.app/settings/dash/google/callback");
  await expect(completeGoogleOAuth(oauth, { code: "auth-code", state: "nope" })).rejects.toThrow(/expired or did not match/);
});

test("callback maps Google access_denied", async () => {
  const oauth = await client();
  await expect(completeGoogleOAuth(oauth, { error: "access_denied" })).rejects.toThrow(/cancelled/);
});

test("refreshes an expired access token and keeps the refresh token", async () => {
  const oauth = await client();
  await writeGoogleTokens(oauth.tokenPath, {
    accessToken: "old-access",
    refreshToken: "1//refresh",
    expiresAt: 1_700_000_000_000 - 1,
  });
  oauth.fetchImpl = async (_input, init) => {
    expect(String(init?.body)).toContain("grant_type=refresh_token");
    return tokenResponse({ access_token: "ya29.new", refresh_token: undefined });
  };
  expect(await ensureGoogleAccessToken(oauth)).toBe("ya29.new");
  const stored = JSON.parse(await readFile(oauth.tokenPath, "utf8")) as { refreshToken: string; accessToken: string };
  expect(stored.accessToken).toBe("ya29.new");
  expect(stored.refreshToken).toBe("1//refresh");
});

test("disconnect deletes stored tokens", async () => {
  const oauth = await client();
  await writeGoogleTokens(oauth.tokenPath, {
    accessToken: "ya29.access",
    refreshToken: "1//refresh",
    expiresAt: 1_700_000_000_000 + 3_600_000,
  });
  await disconnectGoogleOAuth(oauth);
  await expect(ensureGoogleAccessToken(oauth)).rejects.toThrow(/not connected/);
});
