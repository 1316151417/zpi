import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globalSetup: "./tests/safety-check.ts",
    projects: [
      {
        test: {
          name: "node",
          include: ["packages/*/test/**/*.test.ts"],
          environment: "./tests/unit-environment.ts",
          exclude: [
            "packages/desktop/test/web-settings-actions.test.ts",
            "packages/desktop/test/quick-chat-renderer.test.ts",
            "packages/desktop/test/quick-chat-settings-dom.test.ts",
          ],
        },
      },
      {
        test: {
          name: "dom",
          include: [
            "packages/desktop/test/web-settings-actions.test.ts",
            "packages/desktop/test/quick-chat-renderer.test.ts",
            "packages/desktop/test/quick-chat-settings-dom.test.ts",
          ],
          environment: "./tests/dom-environment.ts",
        },
      },
    ],
    isolate: true,
    unstubEnvs: true,
    // Leave capacity for the desktop; dedicated runs can pass --maxWorkers=100%.
    maxWorkers: "50%",
    testTimeout: 15000,
  },
});
