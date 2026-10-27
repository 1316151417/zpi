import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { DesktopEventEnvelope } from "zpi-ui";
import type { DesktopBridge } from "../src/shared/bridge.ts";

const electron = vi.hoisted(() => ({ expose: vi.fn() }));
const ipc = new EventEmitter();
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: ipc,
  webUtils: {},
}));

it("delivers one batch to the store and ordered individual events to sparse pane subscribers", async () => {
  await import("../src/preload/index.ts");
  const bridge = electron.expose.mock.calls[0][1] as DesktopBridge;
  const batch = vi.fn(),
    single = vi.fn();
  const offBatch = bridge.onEvents(batch),
    offSingle = bridge.onEvent(single);
  const events: DesktopEventEnvelope[] = [1, 2].map((seq) => ({
    sessionId: "s",
    runId: "r",
    seq,
    event: { type: "block_delta", messageId: "m", contentIndex: 0, delta: String(seq) },
  }));
  ipc.emit("zpi:events", { sender: "private-ipc-context" }, events);
  expect(batch).toHaveBeenCalledExactlyOnceWith(events);
  expect(single.mock.calls).toEqual(events.map((event) => [event]));
  offBatch();
  ipc.emit("zpi:events", {}, events);
  expect(batch).toHaveBeenCalledOnce();
  expect(single).toHaveBeenCalledTimes(4);
  offSingle();
  expect(ipc.listenerCount("zpi:events")).toBe(0);
});
