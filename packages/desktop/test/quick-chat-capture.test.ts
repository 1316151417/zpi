import { expect, test, vi } from "vitest";
import { QuickChatCapture } from "../src/main/quick-chat-capture.ts";

function fixture() {
  let session = "first";
  const read = vi.fn<ConstructorParameters<typeof QuickChatCapture>[0]["read"]>();
  const open = vi.fn(async () => {});
  const hide = vi.fn();
  const capture = new QuickChatCapture({ sessionId: () => session, read, open, hide });
  return {
    capture,
    read,
    open,
    hide,
    reset: () => {
      session = "next";
    },
  };
}
test("clipboard read and warm handoff start before returning from the shortcut callback", async () => {
  const f = fixture();
  f.read.mockReturnValue({ text: "clipboard" });
  const pending = f.capture.invoke("clipboard");
  expect(f.read).toHaveBeenCalledOnce();
  expect(f.open).toHaveBeenCalledWith({ text: "clipboard" }, "first");
  expect(f.hide).not.toHaveBeenCalled();
  await pending;
});
test("selection is captured before focus changes; repeated requests append only once", async () => {
  const f = fixture();
  const selected = Promise.withResolvers<{ text: string }>();
  f.read.mockReturnValue(selected.promise);
  const pending = f.capture.invoke("selection");
  const repeated = f.capture.invoke("selection");
  expect(f.read).toHaveBeenCalledOnce();
  expect(f.open).not.toHaveBeenCalled();
  expect(f.hide).not.toHaveBeenCalled();
  selected.resolve({ text: "selected" });
  await pending;
  await repeated;
  expect(f.open).toHaveBeenCalledExactlyOnceWith({ text: "selected" }, "first");
});
test.each(["cancel", "reset", "dispose"] as const)(
  "%s prevents a late screenshot from reaching a session",
  async (action) => {
    const f = fixture();
    const selected = Promise.withResolvers<{ text: string } | undefined>();
    f.read.mockReturnValue(selected.promise);
    const pending = f.capture.invoke("screenshot");
    expect(f.hide).toHaveBeenCalledOnce();
    if (action === "reset") f.reset();
    if (action === "dispose") f.capture.dispose();
    selected.resolve(action === "cancel" ? undefined : { text: "late" });
    await pending;
    expect(f.open).not.toHaveBeenCalled();
  },
);
test("failed capture releases admission and a retry can open", async () => {
  const f = fixture();
  f.read.mockRejectedValueOnce(new Error("permission"));
  await expect(f.capture.invoke("selection")).rejects.toThrow("permission");
  f.read.mockReturnValue({ text: "retry" });
  await f.capture.invoke("selection");
  expect(f.open).toHaveBeenCalledExactlyOnceWith({ text: "retry" }, "first");
});
