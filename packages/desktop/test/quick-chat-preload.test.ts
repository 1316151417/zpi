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
    "onSnapshot",
    "openExternal",
    "reset",
    "send",
    "stop",
  ]);
  await bridge.send("question");
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "send", ["question"]);
  await bridge.reset();
  expect(electron.invoke).toHaveBeenLastCalledWith("zpi:quick-chat", "reset", []);
  const listener = vi.fn();
  const off = bridge.onSnapshot(listener);
  const [channel, handler] = electron.on.mock.calls[0];
  handler({}, { revision: 2 });
  expect(listener).toHaveBeenCalledWith({ revision: 2 });
  off();
  expect(electron.removeListener).toHaveBeenCalledWith(channel, handler);
});
