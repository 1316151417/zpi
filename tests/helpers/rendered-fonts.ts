import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

// CSS font-family alone cannot detect macOS choosing the larger PingFang SC
// fallback. Inspect the fonts Chromium actually uses for the Chinese glyphs.
export async function expectZCodeSystemFont(page: Page, selectors: string[]) {
  if (process.platform !== "darwin") return;
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument");
    for (const selector of selectors) {
      const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      expect(nodeId, selector).toBeGreaterThan(0);
      const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
      const chineseFonts = fonts.filter((font) => /PingFang/.test(font.postScriptName));
      expect(chineseFonts.length, selector).toBeGreaterThan(0);
      for (const font of chineseFonts) {
        expect(font.postScriptName, selector).toMatch(/^\.PingFangUIDisplaySC-/);
      }
    }
  } finally {
    await client.detach();
  }
}
