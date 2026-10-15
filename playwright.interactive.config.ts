import { defineConfig } from "@playwright/test";

// This separate config is the only supported visible-window opt-in.
export default defineConfig({
  projects: [{ name: "interactive" }],
  testDir: "tests/interactive",
  globalSetup: "./tests/safety-check.ts",
  workers: 1,
  timeout: 30000,
  reporter: "list",
});
