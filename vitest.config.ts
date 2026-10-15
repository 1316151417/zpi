import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globalSetup: "./tests/safety-check.ts",
    include: ["packages/*/test/**/*.test.ts"],
    environment: "./tests/unit-environment.ts",
    isolate: true,
    unstubEnvs: true,
    // Leave capacity for the desktop; dedicated runs can pass --maxWorkers=100%.
    maxWorkers: "50%",
    testTimeout: 15000,
  },
});
