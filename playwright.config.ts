import { defineConfig } from "@playwright/test";
import { assertBackgroundCommand } from "./tests/helpers/test-command.ts";

assertBackgroundCommand(process.argv.slice(2));
process.env.PLAYWRIGHT_HTML_OPEN = "never";

export default defineConfig({
  globalSetup: "./tests/safety-check.ts",
  testDir: "tests/desktop",
  timeout: 30000,
  workers: 1,
  use: { trace: "retain-on-failure" },
  reporter: "list",
});
