// Branch coverage for src/server/app.ts: HSTS on https, the CORS origin policy
// (localhost / 127.0.0.1 / allow-list / rejected), the /auth/callback redirect,
// and the generic onError 500 path (a non-BackendUnavailableError bubbling up).
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { DenoKvStore } from "../src/store/denokv.ts";
import { StaticCipher } from "../src/crypto/static.ts";
import { TestClock } from "./support/clock.ts";
import { GoogleFake } from "./support/google-fake.ts";
import { startTestServer } from "./support/test-server.ts";
import { testConfig } from "./support/test-server.ts";
import { req } from "./support/oauth-driver.ts";

describe("app security headers", () => {
  it("sets_hsts_only_for_https_requests", async () => {
    const s = await startTestServer();
    const https = await s.app.fetch(new Request("https://localhost:3000/health", { headers: { Accept: "application/json" } }));
    expect(https.headers.get("strict-transport-security")).toContain("max-age=31536000");

    const http = await req(s.app, "/health", { headers: { Accept: "application/json" } });
    expect(http.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("app CORS origin policy", () => {
  it("echoes_localhost_and_127_0_0_1_origins", async () => {
    const s = await startTestServer();
    for (const origin of ["http://localhost:5173", "https://127.0.0.1:8080"]) {
      const r = await req(s.app, "/health", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET", Accept: "application/json" } });
      expect(r.headers.get("access-control-allow-origin"), origin).toBe(origin);
    }
  });

  it("echoes_configured_allowed_origins_and_rejects_others", async () => {
    const s = await startTestServer({ env: { ALLOWED_ORIGINS: "https://app.example.com,https://admin.example.com" } });
    const allowed = await req(s.app, "/health", { method: "OPTIONS", headers: { Origin: "https://app.example.com", "Access-Control-Request-Method": "GET", Accept: "application/json" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example.com");

    const rejected = await req(s.app, "/health", { method: "OPTIONS", headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "GET", Accept: "application/json" } });
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("uses_wildcard_when_no_origin_header", async () => {
    const s = await startTestServer();
    const r = await req(s.app, "/health", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET", Accept: "application/json" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("app /auth/callback", () => {
  it("redirects_to_the_root_callback_path", async () => {
    const s = await startTestServer();
    const r = await req(s.app, "/auth/callback?code=PLANTED_GOOGLE_CODE&state=xyz", { redirect: "manual" });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.pathname).toBe("/callback");
    expect(loc.searchParams.get("code")).toBe("PLANTED_GOOGLE_CODE");
    expect(loc.searchParams.get("state")).toBe("xyz");
  });
});

describe("app onError", () => {
  it("maps_an_unexpected_error_to_500", async () => {
    // A store whose read throws a generic error: the bearer middleware surfaces
    // it, and onError renders the internal_server_error body (not 503).
    const clock = new TestClock();
    const config = testConfig();
    const store = await DenoKvStore.open({ clock: clock.now });
    const boom = new Error("planted unexpected failure");
    const failingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "get") return () => Promise.reject(boom);
        return Reflect.get(target, prop, receiver);
      },
    });
    const deps: AppDeps = {
      store: failingStore as typeof store,
      clock: clock.now,
      config,
      cipher: new StaticCipher(config.encryptionSecret!),
      fetch: new GoogleFake().fetch,
    };
    const app = createApp(deps);
    const r = await app.fetch(
      new Request("http://localhost:3000/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer planted-opaque-token", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    expect(r.status).toBe(500);
    expect((await r.json()).error).toBe("internal_server_error");
    await store.close();
  });
});
