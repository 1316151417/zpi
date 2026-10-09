import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchDesktop } from "../helpers/desktop.ts";

test("native composer caret fades smoothly, resets on editing and stays visible during IME", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-composer-caret-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await page.emulateMedia({ colorScheme: "light" });
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("输入");
    await expect(editor).toHaveCSS("caret-animation", "manual");
    await expect(editor).toHaveCSS("animation-duration", "1s");
    const samples = await editor.evaluate((el) => {
      const animation = el.getAnimations().find((a) => a instanceof CSSAnimation);
      if (!animation) throw Error("Expected the native caret animation");
      animation.pause();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw Error("Expected color sampling context");
      const rgba = (color: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      };
      return [0, 250, 500, 800].map((time) => {
        animation.currentTime = time;
        const style = getComputedStyle(el);
        return { caret: style.caretColor, caretRgba: rgba(style.caretColor), textRgba: rgba(style.color) };
      });
    });
    expect(samples[0].caretRgba).toEqual(samples[0].textRgba);
    for (const index of [1, 3]) {
      const alpha = samples[index].caretRgba[3];
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThan(255);
    }
    expect(samples[2].caretRgba[3]).toBe(0);
    expect(new Set(samples.map((sample) => JSON.stringify(sample.textRgba))).size).toBe(1);
    await editor.pressSequentially("X");
    await expect(editor).toHaveCSS("caret-color", samples[0].caret);
    await expect(editor).toHaveText("输入X");
    await editor.evaluate((el) => {
      const animation = el.getAnimations()[0];
      if (animation) animation.currentTime = 500;
    });
    await editor.press("ArrowLeft");
    await expect(editor).toHaveCSS("caret-color", samples[0].caret);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
    await expect(editor).toHaveAttribute("data-composing", "true");
    await expect(editor).toHaveCSS("animation-name", "none");
    await expect(editor).toHaveCSS("caret-color", await editor.evaluate((el) => getComputedStyle(el).color));
    await cdp.send("Input.insertText", { text: "中文" });
    await expect(editor).toHaveText("输入中文X");
    await expect(editor).not.toHaveAttribute("data-composing", "true");
    await expect(editor).toHaveCSS("animation-name", "composer-caret");
    await page.getByLabel("新建任务", { exact: true }).first().focus();
    await expect(editor).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await editor.focus();
    await expect(editor).toHaveCSS("animation-name", "none");
    await expect(editor).toHaveCSS("caret-animation", "manual");
    await expect(editor).toHaveCSS("caret-color", await editor.evaluate((el) => getComputedStyle(el).color));
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
