import { defineConfig } from "@playwright/test";

if (!process.env.ZPI_CLEANUP_REPORT) throw new Error("Use node scripts/verify-test-cleanup.mjs");
export default defineConfig({
  testDir: ".",
  outputDir: `${process.env.ZPI_CLEANUP_REPORT}.artifacts`,
  testMatch: "cleanup.probe.ts",
  timeout: 30000,
  workers: 1,
  reporter: "line",
  globalSetup: "../safety-check.ts",
});
