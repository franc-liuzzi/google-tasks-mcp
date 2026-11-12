// Structured logger: level gating, sensitive-data redaction, and context
// formatting. The current level is read from LOG_LEVEL at module load, so the
// trace/debug cases re-import the module with the env stubbed.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function freshLogger(level?: string) {
  vi.resetModules();
  if (level === undefined) vi.stubEnv("LOG_LEVEL", "");
  else vi.stubEnv("LOG_LEVEL", level);
  const mod = await import("../../src/utils/logger.ts");
  return mod.createLogger;
}

describe("createLogger level gating", () => {
  it("default_level_info_suppresses_trace_and_debug", async () => {
    const createLogger = await freshLogger();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createLogger({ component: "unit" });
    logger.trace("t");
    logger.debug("d");
    expect(log).not.toHaveBeenCalled();

    logger.info("i");
    expect(log).toHaveBeenCalledTimes(1);
    logger.warn("w");
    expect(warn).toHaveBeenCalledTimes(1);
    logger.error("e");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("trace_level_emits_every_level", async () => {
    const createLogger = await freshLogger("trace");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createLogger();
    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    expect(log).toHaveBeenCalledTimes(3);
    logger.warn("w");
    expect(warn).toHaveBeenCalledTimes(1);
    logger.error("e");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("error_level_suppresses_lower_levels", async () => {
    const createLogger = await freshLogger("error");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createLogger();
    logger.info("i");
    logger.warn("w");
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    logger.error("e");
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("createLogger formatting", () => {
  it("redacts_sensitive_values_and_renders_context", async () => {
    const createLogger = await freshLogger("trace");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const logger = createLogger({ component: "secrets" });
    logger.info("got access_token=abc123DEF", { attempt: 3 });

    const line = log.mock.calls[0][0] as string;
    expect(line).toContain("[secrets]");
    expect(line).toContain("INFO");
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("abc123DEF");
    // Non-component context fields are rendered as key=value JSON.
    expect(line).toContain("attempt=3");
  });

  it("omits_component_and_context_when_absent", async () => {
    const createLogger = await freshLogger("trace");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    // No default context at all exercises the `context ? ... : ""` false arm.
    const logger = createLogger();
    logger.info("plain message");

    const line = log.mock.calls[0][0] as string;
    expect(line).toContain("plain message");
    expect(line).not.toContain("[");
  });

  it("redacts_refresh_token_client_secret_and_bearer", async () => {
    const createLogger = await freshLogger("trace");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const logger = createLogger();
    logger.info("refresh_token=rtok client_secret=csec authorization: Bearer btok code=acode userid=7");

    const line = log.mock.calls[0][0] as string;
    for (const secret of ["rtok", "csec", "btok", "acode"]) {
      expect(line, secret).not.toContain(secret);
    }
    expect(line).toContain("[REDACTED]");
  });
});
