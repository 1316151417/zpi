import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import type { DesktopBridge } from "../src/shared/bridge.ts";

const electron = vi.hoisted(() => ({ expose: vi.fn() }));
const ipc = new EventEmitter();
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: ipc,
  webUtils: {},
}));
test("modifier subscription forwards native state without exposing IPC events and removes only its listener", async () => {
  await import("../src/preload/index.ts");
  const bridge = electron.expose.mock.calls[0][1] as DesktopBridge;
  const change = vi.fn(),
    other = vi.fn();
  const dispose = bridge.onShortcutModifier(change);
  const disposeOther = bridge.onShortcutModifier(other);
  ipc.emit("zpi:shortcut-modifier", { sender: "private" }, true);
  expect(change).toHaveBeenCalledExactlyOnceWith(true);
  ipc.emit("zpi:shortcut-modifier", {}, false);
  expect(change).toHaveBeenLastCalledWith(false);
  dispose();
  change.mockClear();
  ipc.emit("zpi:shortcut-modifier", {}, true);
  expect(change).not.toHaveBeenCalled();
  expect(other).toHaveBeenLastCalledWith(true);
  disposeOther();
  expect(ipc.listenerCount("zpi:shortcut-modifier")).toBe(0);
});
