import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuickChatWindow } from "../../packages/desktop/src/main/quick-chat-window.ts";
import type { QuickChatDraftInput } from "../../packages/desktop/src/shared/quick-chat.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { nativeWindowOrder } from "../helpers/native-window-order.ts";
import { launchQuickChatFixture } from "../helpers/quick-chat-fixture.ts";
import { expect, test } from "../helpers/test.ts";

interface Fixture {
  quickChatFixture: QuickChatWindow;
  beginQuickChatCaptureFixture(): void;
  finishQuickChatCaptureFixture(input?: QuickChatDraftInput): Promise<void>;
  createQuickChatMainFixture(): Promise<number>;
}

// Real applications/WindowServer/host/preload/renderer, with only the screenshot
// source injected. No system screenshot, clipboard, keyboard or external editor.
test("interactive: screenshot completion and cancellation retain the source focus and main-window order", async ({
  desktopIsolation: _isolation,
}, info) => {
  test.skip(process.platform !== "darwin", "macOS application focus");
  const dir = await mkdtemp(join(tmpdir(), "zpi-capture-focus-"));
  const sourceDir = await mkdtemp(join(tmpdir(), "zpi-capture-source-"));
  const app = await launchQuickChatFixture(dir, "");
  const quick = await app.firstWindow();
  const mainId = await app.evaluate(() =>
    (globalThis as typeof globalThis & Fixture).createQuickChatMainFixture(),
  );
  const source = await launchDesktop({ dir: sourceDir, url: "" });
  await source.firstWindow();
  const observe = await nativeWindowOrder(dir, [app.process().pid, source.process().pid]);
  const sourceFocused = () =>
    source.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused());
  const state = async () => ({
    native: await observe(),
    main: await app.evaluate(({ app, BrowserWindow }, id) => {
      const main = BrowserWindow.fromId(id);
      return { visible: main?.isVisible(), focused: main?.isFocused(), appHidden: app.isHidden() };
    }, mainId),
  });
  const behindSource = async () => {
    const windows = (await observe()).details.filter((window) => window.layer === 0);
    const a = windows.findIndex((window) => window.pid === app.process().pid);
    const b = windows.findIndex((window) => window.pid === source.process().pid);
    return a >= 0 && b >= 0 && a > b;
  };
  const samples: unknown[] = [];
  const record = async (name: string) => {
    const path = info.outputPath("capture-focus.json");
    await writeFile(path, JSON.stringify(samples, null, 2));
    await info.attach(name, { path, contentType: "application/json" });
  };
  for (const complete of [false, true]) {
    await app.evaluate(({ BrowserWindow }, id) => {
      const main = BrowserWindow.fromId(id);
      main?.setBounds({ x: 120, y: 120, width: 740, height: 560 });
      main?.show();
    }, mainId);
    await source.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setBounds({ x: 60, y: 60, width: 850, height: 600 });
      window.show();
      app.focus({ steal: true });
      window.focus();
    });
    await expect.poll(sourceFocused).toBe(true);
    await app.evaluate(() => (globalThis as typeof globalThis & Fixture).quickChatFixture.show());
    await quick.getByRole("textbox", { name: "输入消息", exact: true }).fill("保留截图前草稿");
    await app.evaluate(() => (globalThis as typeof globalThis & Fixture).beginQuickChatCaptureFixture());
    const capturing = await state();
    samples.push({ complete, capturing });
    await record(`capture-${complete}`);
    await expect.poll(sourceFocused).toBe(true);
    await expect.poll(behindSource).toBe(true);
    expect(capturing.main).toEqual({ visible: true, focused: false, appHidden: false });
    await app.evaluate(async (_electron, complete) => {
      const fixture = globalThis as typeof globalThis & Fixture;
      await fixture.finishQuickChatCaptureFixture(
        complete
          ? {
              image: {
                name: "isolated-capture.png",
                bytes: Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWN415H2riONAUIBADY+B3G73tFAAAAAAElFTkSuQmCC",
                  "base64",
                ),
              },
            }
          : undefined,
      );
    }, complete);
    if (complete) {
      await expect(quick.locator(".quick-chat-attachment img")).toHaveCount(1);
      await expect(quick.getByRole("textbox", { name: "输入消息", exact: true })).toHaveValue(
        "保留截图前草稿",
      );
      await quick.evaluate(() => window.zpiQuickChat.hide());
    }
    await expect.poll(sourceFocused).toBe(true);
    await expect.poll(behindSource).toBe(true);
    expect((await state()).main).toEqual({ visible: true, focused: false, appHidden: false });
    samples.push({ complete, after: await state() });
  }
  await record("capture-focus-final");
});
