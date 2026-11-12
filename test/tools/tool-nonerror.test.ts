// The tools' catch blocks format `error instanceof Error ? error.message :
// String(error)`. The happy/error fixture paths always throw real Errors, so
// this suite drives the *non-Error* branch: the injected fetch rejects with a
// plain string for Tasks API calls (OAuth still uses the faithful Google fake).
import { beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../support/test-server.ts";
import { GoogleFake } from "../support/google-fake.ts";
import { login } from "../support/oauth-driver.ts";
import { callTool } from "../support/mcp-client.ts";
import { TOOL_CASES } from "../support/tool-cases.ts";

const NON_ERROR_MESSAGE = "planted non-error rejection";

describe("tools non-Error rejection", () => {
  let s: TestServer;
  let token: string;

  beforeEach(async () => {
    const google = new GoogleFake();
    // Delegate to the fake for OAuth (login, refresh, revoke), but reject Tasks
    // API calls with a bare string so the tool catch hits the String(error) arm.
    const fetchSeam: typeof fetch = (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.hostname === "tasks.googleapis.com") {
        return Promise.reject(NON_ERROR_MESSAGE) as unknown as Promise<Response>;
      }
      return google.fetch(input, init);
    };
    s = await startTestServer({ google, fetch: fetchSeam });
    token = (await login(s.app, s.google)).tokens.access_token;
  });

  for (const c of TOOL_CASES) {
    it(`${c.tool}_formats_non_error_rejection`, async () => {
      const r = await callTool(s.app, token, c.tool, c.args);
      expect(r.status).toBe(200);
      expect(r.result.isError).toBe(true);
      const text = r.result.content?.[0]?.text ?? "";
      expect(text).toContain(NON_ERROR_MESSAGE);
    });
  }
});
