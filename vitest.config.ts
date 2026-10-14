import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    isolate: true,
    unstubEnvs: true,
    // Leave capacity for the desktop; dedicated runs can pass --maxWorkers=100%.
    maxWorkers: "50%",
    testTimeout: 15000,
  },
});
