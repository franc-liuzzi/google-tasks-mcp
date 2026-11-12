import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/support/invariants-setup.ts"],
    env: { TZ: "UTC" },
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // src/index.ts is the Deno Deploy entry point; it is 0% / not
      // exercisable under Node vitest, so it is excluded from coverage.
      exclude: ["src/index.ts"],
      reporter: ["text", "html"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
