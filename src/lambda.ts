// AWS Lambda entrypoint (API Gateway): exports a `handle`-wrapped handler.
// At cold start, if the config names a Secrets Manager secret
// (googleOAuthSecretId), the single secret holding the OAuth client is fetched
// and GOOGLE_CLIENT_ID/SECRET are injected into process.env, then the config is
// reloaded so it picks them up. config.ts stays the only module that interprets
// environment variables; this module reads the secret id from the config, never
// from process.env directly. With no AWS env the module imports cleanly.
import process from "node:process";
import { handle } from "@hono/aws-lambda";
import { type Config, loadConfig } from "./config.ts";
import { buildDeps } from "./deps.ts";
import { createApp } from "./server/app.ts";

async function injectOAuthSecret(config: Config): Promise<void> {
  const secretId = config.googleOAuthSecretId;
  if (!secretId) return;
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region: config.awsRegion });
  try {
    const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    const parsed = JSON.parse(res.SecretString ?? "{}") as { client_id?: string; client_secret?: string };
    if (parsed.client_id) process.env.GOOGLE_CLIENT_ID = parsed.client_id;
    if (parsed.client_secret) process.env.GOOGLE_CLIENT_SECRET = parsed.client_secret;
  } finally {
    client.destroy();
  }
}

// First load reads the secret id (and region) from the environment; after the
// secret is injected, reload so the OAuth client values are picked up.
const initialConfig = loadConfig(process.env);
await injectOAuthSecret(initialConfig);
const app = createApp(await buildDeps(loadConfig(process.env)));

export const handler = handle(app);
