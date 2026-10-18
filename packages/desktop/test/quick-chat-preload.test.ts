import { expect, test, vi } from "vitest";
import type { QuickChatBridge } from "../src/shared/quick-chat.ts";

const electron = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));
test("quick-chat preload exposes only its narrow isolated bridge and unsubscribes snapshots", async () => {
  await import("../src/preload/quick-chat.ts");
  expect(electron.expose).toHaveBeenCalledExactlyOnceWith("zpiQuickChat", expect.any(Object));
  const bridge = electron.expose.mock.calls[0][1] as QuickChatBridge;
  expect(Object.keys(bridge).sort()).toEqual([
    "copyText",
    "getSnapshot",
    "hide",
    "importAttachment",
    "onComposerProbe",
    "onDraftInput",
    "onPresentation",
    "onSnapshot",
    "openExternal",
    "readAttachment",
    "readWebSourceIcon",
    "removeAttachment",
    "rendererCommitted",
    "rendererReady",
    "reportComposerState",
    "reportPresentation",
    "reset",
    "send",
    "setComposerHeight",
    "setNoticeHeight",
    "stop",
    "takeDraftInput",
  ]);
  await bridge.send("question");
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "send", ["question"]);
  await bridge.send("", ["image-id"]);
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "send", ["", ["image-id"]]);
  const file = new File([new Uint8Array([1, 2, 3])], "clipboard.png", { type: "image/png" });
  await bridge.importAttachment("session", file);
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "importAttachment", [
    "session",
    "clipboard.png",
    new Uint8Array([1, 2, 3]),
  ]);
  const arrayBuffer = vi.fn();
  const oversized = { size: 10 * 1024 * 1024 + 1, arrayBuffer } as unknown as File;
  expect(await bridge.importAttachment("session", oversized)).toMatchObject({
    ok: false,
    error: { code: "invalid_input" },
  });
  expect(arrayBuffer).not.toHaveBeenCalled();
  await bridge.readAttachment("session", "image-id");
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "readAttachment", [
    "session",
    "image-id",
  ]);
  await bridge.removeAttachment("session", "image-id");
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "removeAttachment", [
    "session",
    "image-id",
  ]);
  await bridge.reset();
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "reset", []);
  await bridge.readWebSourceIcon("session", "run", "https://example.com/article");
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "readWebSourceIcon", [
    "session",
    "run",
    "https://example.com/article",
  ]);
  await bridge.setComposerHeight("session", 92);
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "setComposerHeight", ["session", 92]);
  await bridge.setNoticeHeight("session", 172);
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "setNoticeHeight", ["session", 172]);
  await bridge.setNoticeHeight("session", 0);
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "setNoticeHeight", ["session", 0]);
  await bridge.rendererReady("session", 3);
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "rendererReady", ["session", 3]);
  await bridge.reportComposerState(7, "session", false);
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "reportComposerState", [
    7,
    "session",
    false,
  ]);
  const probed = vi.fn();
  const offProbe = bridge.onComposerProbe(probed);
  const [probeChannel, probeHandler] = electron.on.mock.calls[electron.on.mock.calls.length - 1];
  probeHandler({}, 7, "session");
  expect(probed).toHaveBeenCalledWith(7, "session");
  offProbe();
  expect(electron.removeListener).toHaveBeenCalledWith(probeChannel, probeHandler);
  await bridge.reportPresentation(1, "renderer-frame");
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "reportPresentation", [
    1,
    "renderer-frame",
  ]);
  const presented = vi.fn();
  const offPresentation = bridge.onPresentation(presented);
  const [presentationChannel, presentationHandler] =
    electron.on.mock.calls[electron.on.mock.calls.length - 1];
  presentationHandler({}, 1);
  expect(presented).toHaveBeenCalledWith(1);
  offPresentation();
  expect(electron.removeListener).toHaveBeenCalledWith(presentationChannel, presentationHandler);
  const listener = vi.fn();
  const off = bridge.onSnapshot(listener);
  const [channel, handler] = electron.on.mock.calls[electron.on.mock.calls.length - 1];
  handler({}, { revision: 2 });
  expect(listener).toHaveBeenCalledWith({ revision: 2 });
  off();
  expect(electron.removeListener).toHaveBeenCalledWith(channel, handler);
});
