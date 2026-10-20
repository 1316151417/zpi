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

test("directory changes share one IPC listener and route only to the matching live subscriptions", async () => {
  await import("../src/preload/index.ts");
  const bridge = electron.expose.mock.calls[0][1] as DesktopBridge;
  const first = vi.fn(),
    second = vi.fn(),
    other = vi.fn();
  const disposeFirst = bridge.onWorkspaceDirectoryChange("one", first);
  const disposeSecond = bridge.onWorkspaceDirectoryChange("one", second);
  const disposeOther = bridge.onWorkspaceDirectoryChange("two", other);
  expect(ipc.listenerCount("zpi:workspace-directory")).toBe(1);
  ipc.emit("zpi:workspace-directory", { sender: "private" }, { id: "one", dirPath: "/workspace" });
  expect(first).toHaveBeenCalledExactlyOnceWith({ dirPath: "/workspace" });
  expect(second).toHaveBeenCalledExactlyOnceWith({ dirPath: "/workspace" });
  expect(other).not.toHaveBeenCalled();
  disposeFirst();
  disposeSecond();
  const replacement = vi.fn();
  const disposeReplacement = bridge.onWorkspaceDirectoryChange("one", replacement);
  disposeFirst();
  ipc.emit("zpi:workspace-directory", {}, { id: "one", dirPath: "/new" });
  expect(replacement).toHaveBeenCalledExactlyOnceWith({ dirPath: "/new" });
  expect(second).toHaveBeenCalledTimes(1);
  disposeOther();
  disposeReplacement();
  expect(ipc.listenerCount("zpi:workspace-directory")).toBe(0);
});
