import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
] as const;

const PENDING_TTL_MS = 20 * 60 * 1000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type GoogleTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  tokenType?: string;
};

export type GoogleOAuthPending = {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
};

export type GoogleFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type GoogleOAuthClient = {
  clientId: string;
  clientSecret: string;
  tokenPath: string;
  pendingPath?: string;
  now?: () => number;
  fetchImpl?: GoogleFetch;
};

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
};

export function defaultGoogleTokenPath(): string {
  return join(homedir(), ".pi/agent/google-oauth.json");
}

export function defaultGooglePendingPath(tokenPath = defaultGoogleTokenPath()): string {
  return tokenPath.replace(/\.json$/i, "-pending.json");
}

export function googleOAuthConfigured(client: Pick<GoogleOAuthClient, "clientId" | "clientSecret">): boolean {
  return Boolean(client.clientId.trim() && client.clientSecret.trim());
}

export async function googleOAuthConnected(tokenPath: string): Promise<boolean> {
  const tokens = await readGoogleTokens(tokenPath);
  return Boolean(tokens?.refreshToken);
}

export async function startGoogleOAuth(
  client: GoogleOAuthClient,
  redirectUri: string,
): Promise<{ authorizeUrl: string; pending: GoogleOAuthPending }> {
  if (!googleOAuthConfigured(client)) {
    throw new Error("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env, then re-run provision.");
  }
  const pending: GoogleOAuthPending = {
    state: randomUrlSafe(24),
    codeVerifier: randomUrlSafe(32),
    redirectUri,
    createdAt: nowMs(client),
  };
  await writeJson(pendingPath(client), pending);
  const params = new URLSearchParams({
    client_id: client.clientId.trim(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES.join(" "),
    state: pending.state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    code_challenge: pkceChallenge(pending.codeVerifier),
    code_challenge_method: "S256",
  });
  return { authorizeUrl: `${GOOGLE_AUTHORIZE_URL}?${params}`, pending };
}

export async function completeGoogleOAuth(
  client: GoogleOAuthClient,
  params: { code?: string | null; state?: string | null; error?: string | null },
): Promise<GoogleTokens> {
  if (params.error) {
    throw new Error(oauthUserError(params.error));
  }
  const code = params.code?.trim();
  const state = params.state?.trim();
  if (!code || !state) {
    throw new Error("Google sign-in did not return a code. Try Connect again.");
  }
  const pending = await readPending(client);
  if (!pending || pending.state !== state) {
    throw new Error("Google sign-in expired or did not match. Try Connect again.");
  }
  if (nowMs(client) - pending.createdAt > PENDING_TTL_MS) {
    await deleteFile(pendingPath(client));
    throw new Error("Google sign-in expired. Try Connect again.");
  }

  const tokens = await exchangeToken(client, {
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.codeVerifier,
  });
  if (!tokens.refreshToken) {
    throw new Error("Google did not return a refresh token. Re-create the OAuth client and click Connect again.");
  }
  await writeGoogleTokens(client.tokenPath, tokens);
  await deleteFile(pendingPath(client));
  return tokens;
}

export async function disconnectGoogleOAuth(client: Pick<GoogleOAuthClient, "tokenPath" | "pendingPath">): Promise<void> {
  await deleteFile(client.tokenPath);
  await deleteFile(pendingPath(client));
}

export async function ensureGoogleAccessToken(client: GoogleOAuthClient): Promise<string> {
  const tokens = await readGoogleTokens(client.tokenPath);
  if (!tokens?.refreshToken) {
    throw new Error("Google is not connected. Open settings and click Connect.");
  }
  if (tokens.accessToken && tokens.expiresAt - REFRESH_SKEW_MS > nowMs(client)) {
    return tokens.accessToken;
  }
  const refreshed = await exchangeToken(client, {
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  });
  const next: GoogleTokens = {
    ...tokens,
    ...refreshed,
    refreshToken: refreshed.refreshToken || tokens.refreshToken,
  };
  await writeGoogleTokens(client.tokenPath, next);
  return next.accessToken;
}

export async function readGoogleTokens(path: string): Promise<GoogleTokens | undefined> {
  const raw = await readJson(path);
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.accessToken !== "string" || typeof value.refreshToken !== "string") return undefined;
  if (typeof value.expiresAt !== "number") return undefined;
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    scope: typeof value.scope === "string" ? value.scope : undefined,
    tokenType: typeof value.tokenType === "string" ? value.tokenType : undefined,
  };
}

async function exchangeToken(
  client: GoogleOAuthClient,
  fields: Record<string, string>,
): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    client_id: client.clientId.trim(),
    client_secret: client.clientSecret.trim(),
    ...fields,
  });
  const fetchImpl = client.fetchImpl ?? fetch;
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  let parsed: TokenResponse;
  try {
    parsed = (await response.json()) as TokenResponse;
  } catch {
    throw new Error(`Google token request failed (${response.status}).`);
  }
  if (!response.ok || typeof parsed.error === "string") {
    throw new Error(tokenErrorMessage(parsed, response.status));
  }
  if (typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw new Error("Google token request did not return an access token.");
  }
  const expiresIn =
    typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in) ? parsed.expires_in : 3600;
  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : "",
    expiresAt: nowMs(client) + expiresIn * 1000,
    scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
    tokenType: typeof parsed.token_type === "string" ? parsed.token_type : "Bearer",
  };
}

function tokenErrorMessage(parsed: TokenResponse, status: number): string {
  if (parsed.error === "invalid_grant") {
    return "Google rejected the sign-in. Click Connect and try again.";
  }
  if (typeof parsed.error === "string") {
    return `Google token request failed (${parsed.error}).`;
  }
  return `Google token request failed (${status}).`;
}

function oauthUserError(error: string): string {
  if (error === "access_denied") return "Google sign-in was cancelled.";
  return "Google sign-in failed. Try Connect again.";
}

async function readPending(client: GoogleOAuthClient): Promise<GoogleOAuthPending | undefined> {
  const raw = await readJson(pendingPath(client));
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.state !== "string" || typeof value.codeVerifier !== "string") return undefined;
  if (typeof value.redirectUri !== "string" || typeof value.createdAt !== "number") return undefined;
  return {
    state: value.state,
    codeVerifier: value.codeVerifier,
    redirectUri: value.redirectUri,
    createdAt: value.createdAt,
  };
}

export async function writeGoogleTokens(path: string, tokens: GoogleTokens): Promise<void> {
  await writeJson(path, tokens);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUrlSafe(6)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function deleteFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function pendingPath(client: Pick<GoogleOAuthClient, "tokenPath" | "pendingPath">): string {
  return client.pendingPath ?? defaultGooglePendingPath(client.tokenPath);
}

function nowMs(client: Pick<GoogleOAuthClient, "now">): number {
  return client.now?.() ?? Date.now();
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function randomUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
