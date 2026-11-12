// AwsKmsCipher against a faithful AWS KMS fake. Oracle: properties.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Buffer } from "node:buffer";
import { AwsKmsCipher } from "../../src/crypto/awskms.ts";
import { BackendUnavailableError } from "../../src/store/store.ts";
import { AwsKmsFake } from "../support/aws-kms-fake.ts";
import { startTestServer } from "../support/test-server.ts";
import { login } from "../support/oauth-driver.ts";
import { callTool } from "../support/mcp-client.ts";

const KEY = "arn:aws:kms:eu-west-1:111122223333:key/abcd-1234";

describe("AwsKmsCipher", () => {
  it("roundtrip", async () => {
    const c = new AwsKmsCipher(new AwsKmsFake(), KEY);
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: "binary" }), async (s) => {
        expect(await c.decrypt(await c.encrypt(s))).toBe(s);
      }),
      { numRuns: 100 },
    );
  });

  it("ciphertext_hides_plaintext", async () => {
    const c = new AwsKmsCipher(new AwsKmsFake(), KEY);
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 8 }), async (s) => {
        const ct = await c.encrypt(s);
        expect(ct).not.toContain(s);
        expect(Buffer.from(ct, "base64").toString("utf-8")).not.toContain(s);
      }),
      { numRuns: 50 },
    );
  });

  it("tamper_throws", async () => {
    const c = new AwsKmsCipher(new AwsKmsFake(), KEY);
    const raw = Buffer.from(await c.encrypt("PLANTED_GOOGLE_REFRESH_A"), "base64");
    raw[raw.length - 1] ^= 1;
    await expect(c.decrypt(raw.toString("base64"))).rejects.toThrow();
  });

  it("wrong_key_throws", async () => {
    // A blob from one KMS key cannot be decrypted by a different key.
    const ct = await new AwsKmsCipher(new AwsKmsFake(), KEY).encrypt("PLANTED_GOOGLE_REFRESH_A");
    await expect(new AwsKmsCipher(new AwsKmsFake(), KEY).decrypt(ct)).rejects.toThrow();
  });

  it("unavailable_maps_to_backend_error", async () => {
    const kms = new AwsKmsFake();
    const c = new AwsKmsCipher(kms, KEY);
    kms.failNext("ThrottlingException");
    await expect(c.encrypt("x")).rejects.toBeInstanceOf(BackendUnavailableError);
    // KMSInternalException carries httpStatusCode 500 (see AwsKmsFake): it is an
    // outage both by name and by status.
    kms.failNext("KMSInternalException");
    await expect(c.encrypt("x")).rejects.toBeInstanceOf(BackendUnavailableError);
    kms.failNext("InvalidCiphertextException"); // not an outage
    await expect(c.encrypt("x")).rejects.not.toBeInstanceOf(BackendUnavailableError);
  });

  it("unavailable_mapping_covers_decrypt_and_status_503", async () => {
    const kms = new AwsKmsFake();
    const c = new AwsKmsCipher(kms, KEY);
    // A ciphertext we can hand to decrypt; the guard fires before it is used.
    const ct = await c.encrypt("PLANTED_GOOGLE_REFRESH_A");
    kms.failNext("ThrottlingException");
    await expect(c.decrypt(ct)).rejects.toBeInstanceOf(BackendUnavailableError);
    // A pure-status outage (503) with an otherwise unknown error name.
    kms.failNext("ServiceUnavailable", 503);
    await expect(c.decrypt(ct)).rejects.toBeInstanceOf(BackendUnavailableError);
    // ...and a 500 with an unknown name (covers the status === 500 arm).
    kms.failNext("UnknownServerError", 500);
    await expect(c.decrypt(ct)).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  it("kms_unavailable_503", async () => {
    const kms = new AwsKmsFake();
    const s = await startTestServer({ cipher: new AwsKmsCipher(kms, KEY) });
    const { tokens } = await login(s.app, s.google);
    kms.failNext("ThrottlingException");
    const r = await callTool(s.app, tokens.access_token, "list_task_lists", {});
    expect(r.status).toBe(503);
    expect(r.text).not.toContain("fake KMS failure");
    expect(JSON.parse(r.text).error).toBe("temporarily_unavailable");
  });
});
