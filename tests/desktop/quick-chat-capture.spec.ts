import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuickChatDraftInput } from "../../packages/desktop/src/shared/quick-chat.ts";
import { launchQuickChatFixture } from "../helpers/quick-chat-fixture.ts";
import { expect, test } from "../helpers/test.ts";

// The source is injected; this exercises real main/preload/React/image decoding,
// without touching OS clipboard, screen capture or accessibility in automation.
test("captured content wakes a retained renderer and appends draft text and PNG without sending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-capture-handoff-"));
  const app = await launchQuickChatFixture(dir, "");
  try {
    const quick = await app.firstWindow();
    const input = quick.getByRole("textbox", { name: "输入消息", exact: true });
    await input.fill("保留草稿");
    const sessionId = await quick.evaluate(async () => {
      const result = await window.zpiQuickChat.getSnapshot();
      if (!result.ok) throw new Error(result.error.message);
      return result.value.session.sessionId;
    });
    await app.evaluate(async (_electron, sessionId) => {
      const control = (
        globalThis as typeof globalThis & {
          quickChatFixture: {
            hide(): void;
            openWithDraft(input: QuickChatDraftInput, sessionId: string): Promise<void>;
          };
        }
      ).quickChatFixture;
      control.hide();
      await control.openWithDraft(
        {
          text: "选中文字",
          image: {
            name: "capture.png",
            bytes: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWN415H2riONAUIBADY+B3G73tFAAAAAAElFTkSuQmCC",
              "base64",
            ),
          },
        },
        sessionId,
      );
    }, sessionId);
    await expect(input).toHaveValue("保留草稿\n选中文字");
    await expect(quick.locator(".quick-chat-attachment img")).toHaveCount(1);
    await expect(quick.getByRole("button", { name: "移除 capture.png", exact: true })).toBeEnabled();
    await expect(quick.getByTestId("run")).toHaveCount(0);
    const after = await quick.evaluate(() => window.zpiQuickChat.getSnapshot());
    expect(after.ok && after.value.session.sessionId).toBe(sessionId);
    await quick.reload();
    await expect(input).toHaveValue("");
    await expect(quick.locator(".quick-chat-attachment")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
