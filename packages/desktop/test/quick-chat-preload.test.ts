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
    "onPresentation",
    "onSnapshot",
    "openExternal",
    "readWebSourceIcon",
    "rendererReady",
    "reportPresentation",
    "reset",
    "send",
    "setComposerHeight",
    "stop",
  ]);
  await bridge.send("question");
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "send", ["question"]);
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
  await bridge.rendererReady("session");
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "rendererReady", ["session"]);
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
