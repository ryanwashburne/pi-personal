import { defaultGoogleTokenPath, ensureGoogleAccessToken } from "./google-oauth";

export async function googleAccessTokenFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return ensureGoogleAccessToken({
    clientId: requiredFrom(env, "GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: requiredFrom(env, "GOOGLE_OAUTH_CLIENT_SECRET"),
    tokenPath: env.GOOGLE_OAUTH_TOKEN_PATH?.trim() || defaultGoogleTokenPath(),
  });
}

function requiredFrom(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

if (import.meta.main) {
  googleAccessTokenFromEnv()
    .then((token) => {
      process.stdout.write(`Bearer ${token}`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
