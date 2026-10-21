import { defineConfig } from "vitest/config";

const domTests = [
  "packages/ui/test/markdown-selection-dom.test.ts",
  "packages/ui/test/notice.test.ts",
  "packages/desktop/test/web-settings-actions.test.ts",
  "packages/desktop/test/quick-chat-renderer.test.ts",
  "packages/desktop/test/quick-chat-settings-dom.test.ts",
  "packages/desktop/test/workspace-editor-dom.test.ts",
  "packages/desktop/test/subagent-settings-dom.test.ts",
  "packages/desktop/test/changes-pane-dom.test.ts",
  "packages/desktop/test/docx-preview-fit-dom.test.ts",
  "packages/desktop/test/composer-interactions-dom.test.ts",
];

export default defineConfig({
  test: {
    globalSetup: "./tests/safety-check.ts",
    projects: [
      {
        test: {
          name: "node",
          include: ["packages/*/test/**/*.test.ts"],
          environment: "./tests/unit-environment.ts",
          exclude: domTests,
        },
      },
      {
        test: {
          name: "dom",
          include: domTests,
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
