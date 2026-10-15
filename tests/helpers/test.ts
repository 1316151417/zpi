import { test as base } from "@playwright/test";
import { desktopScope } from "./desktop-scope.ts";

export { expect } from "@playwright/test";
export const test = base.extend<{ desktopIsolation: undefined }>({
  desktopIsolation: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture parameters.
    async ({}, use, info) => {
      const scope = await desktopScope({ interactive: info.project.name === "interactive" });
      try {
        await use(undefined);
      } finally {
        await scope.close();
      }
    },
    { auto: true, timeout: 15000 },
  ],
});
