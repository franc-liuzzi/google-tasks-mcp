import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import process from "node:process";
import { PLANTED_GOOGLE_CLIENT_CREDENTIAL, PLANTED_GOOGLE_CLIENT_ID, PLANTED_KEY_MATERIAL } from "./support/planted.ts";

// A planted OAuth client delivered through the Secrets Manager edge. These are
// placeholders, never real credentials.
const PLANTED_SECRET_CLIENT_ID = "planted-secret-client-id";
const PLANTED_SECRET_CLIENT_CREDENTIAL = ["planted", "secret", "client", "credential"].join("-");

// Faithful fake of the Secrets Manager client edge (a third-party network
// boundary, not src/). The module under test does `await import(...)`, so the
// mock replaces the whole package. Each test configures `fakeState` before the
// dynamic import runs.
const fakeState: {
  secretString: string | undefined;
  throwName: string | undefined;
  destroyed: boolean;
  getCalls: number;
} = { secretString: undefined, throwName: undefined, destroyed: false, getCalls: 0 };

vi.mock("@aws-sdk/client-secrets-manager", () => {
  class GetSecretValueCommand {
    constructor(public readonly input: { SecretId: string }) {}
  }
  class SecretsManagerClient {
    constructor(public readonly config: { region?: string }) {}
    send(_cmd: GetSecretValueCommand) {
      fakeState.getCalls++;
      if (fakeState.throwName) {
        const err = Object.assign(new Error(`fake secrets failure: ${fakeState.throwName}`), { name: fakeState.throwName });
        return Promise.reject(err);
      }
      return Promise.resolve({ SecretString: fakeState.secretString });
    }
    destroy() {
      fakeState.destroyed = true;
    }
  }
  return { SecretsManagerClient, GetSecretValueCommand };
});

function resetEnv() {
  delete process.env.GOOGLE_OAUTH_SECRET_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.AWS_REGION;
  process.env.ENCRYPTION_SECRET = PLANTED_KEY_MATERIAL;
}

describe("Lambda entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    fakeState.secretString = undefined;
    fakeState.throwName = undefined;
    fakeState.destroyed = false;
    fakeState.getCalls = 0;
    resetEnv();
  });

  afterEach(() => {
    resetEnv();
  });

  it("imports_without_aws_env_and_no_secret_fetch", async () => {
    // No GOOGLE_OAUTH_SECRET_ID: the module must import cleanly and never touch
    // Secrets Manager (local/test path).
    process.env.GOOGLE_CLIENT_ID = PLANTED_GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = PLANTED_GOOGLE_CLIENT_CREDENTIAL;

    const mod = await import("../src/lambda.ts");
    expect(typeof mod.handler).toBe("function");
    expect(fakeState.getCalls).toBe(0);
  });

  it("injects_oauth_client_from_secrets_manager", async () => {
    // A secret id is configured: the cold-start path fetches the single secret,
    // injects GOOGLE_CLIENT_ID/SECRET, and the config reload picks them up.
    process.env.GOOGLE_OAUTH_SECRET_ID = "planted/oauth/secret";
    process.env.AWS_REGION = "eu-west-1";
    fakeState.secretString = JSON.stringify({
      client_id: PLANTED_SECRET_CLIENT_ID,
      client_secret: PLANTED_SECRET_CLIENT_CREDENTIAL,
    });

    const mod = await import("../src/lambda.ts");
    expect(typeof mod.handler).toBe("function");
    expect(fakeState.getCalls).toBe(1);
    expect(process.env.GOOGLE_CLIENT_ID).toBe(PLANTED_SECRET_CLIENT_ID);
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe(PLANTED_SECRET_CLIENT_CREDENTIAL);
    // The client is always torn down in the finally block.
    expect(fakeState.destroyed).toBe(true);
  });

  it("tolerates_secret_without_oauth_fields", async () => {
    // Secret present but empty JSON: nothing is injected, the module still builds.
    process.env.GOOGLE_OAUTH_SECRET_ID = "planted/oauth/secret";
    process.env.GOOGLE_CLIENT_ID = PLANTED_GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = PLANTED_GOOGLE_CLIENT_CREDENTIAL;
    fakeState.secretString = JSON.stringify({});

    const mod = await import("../src/lambda.ts");
    expect(typeof mod.handler).toBe("function");
    expect(fakeState.getCalls).toBe(1);
    // Untouched: the config-provided values remain.
    expect(process.env.GOOGLE_CLIENT_ID).toBe(PLANTED_GOOGLE_CLIENT_ID);
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe(PLANTED_GOOGLE_CLIENT_CREDENTIAL);
    expect(fakeState.destroyed).toBe(true);
  });

  it("defaults_to_empty_object_when_secret_string_missing", async () => {
    // GetSecretValue can return an item with no SecretString; parse must not throw.
    process.env.GOOGLE_OAUTH_SECRET_ID = "planted/oauth/secret";
    process.env.GOOGLE_CLIENT_ID = PLANTED_GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = PLANTED_GOOGLE_CLIENT_CREDENTIAL;
    fakeState.secretString = undefined;

    const mod = await import("../src/lambda.ts");
    expect(typeof mod.handler).toBe("function");
    expect(fakeState.destroyed).toBe(true);
  });

  it("propagates_malformed_secret_and_still_destroys_client", async () => {
    // Malformed JSON surfaces as a parse error; the finally block must still
    // destroy the client (no leak) before the error propagates.
    process.env.GOOGLE_OAUTH_SECRET_ID = "planted/oauth/secret";
    process.env.GOOGLE_CLIENT_ID = PLANTED_GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = PLANTED_GOOGLE_CLIENT_CREDENTIAL;
    fakeState.secretString = "{not valid json";

    await expect(import("../src/lambda.ts")).rejects.toThrow();
    expect(fakeState.getCalls).toBe(1);
    expect(fakeState.destroyed).toBe(true);
  });
});
