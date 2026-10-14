import { expect, test, vi } from "vitest";
import type { DesktopBridge } from "../src/shared/bridge.ts";

const electron = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke, on: vi.fn() },
  webUtils: {},
}));
test("addProject passes only the current session ID or null across the preload IPC boundary", async () => {
  await import("../src/preload/index.ts");
  expect(electron.expose).toHaveBeenCalledExactlyOnceWith("zpi", expect.any(Object));
  const bridge = electron.expose.mock.calls[0][1] as DesktopBridge;
  for (const id of ["current-session", null]) {
    electron.invoke.mockResolvedValueOnce({ ok: true, value: null });
    await expect(bridge.addProject(id)).resolves.toEqual({ ok: true, value: null });
    expect(electron.invoke).toHaveBeenLastCalledWith("zpi:call", "addProject", [id]);
  }
});
