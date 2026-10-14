import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { stopDesktopProcess } from "../../../scripts/dev-process.ts";

function child() {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
  });
}

afterEach(() => vi.useRealTimers());

test.each(["SIGTERM", "SIGKILL"] as const)("already exited with %s does not wait again", async (signal) => {
  const process = child();
  process.signalCode = signal;
  await stopDesktopProcess(process as unknown as ChildProcess);
  expect(process.kill).not.toHaveBeenCalled();
  expect(process.listenerCount("exit")).toBe(0);
});

test("absent and normally exited children require no signal", async () => {
  await stopDesktopProcess(undefined);
  const process = child();
  process.exitCode = 0;
  await stopDesktopProcess(process as unknown as ChildProcess);
  expect(process.kill).not.toHaveBeenCalled();
});

test("graceful exit removes the timer and listener", async () => {
  vi.useFakeTimers();
  const process = child();
  const stopping = stopDesktopProcess(process as unknown as ChildProcess);
  expect(process.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  process.emit("exit", null, "SIGTERM");
  await stopping;
  expect(process.listenerCount("exit")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("unresponsive children get a bounded force-stop attempt", async () => {
  vi.useFakeTimers();
  const process = child();
  const stopping = stopDesktopProcess(process as unknown as ChildProcess, 10);
  await vi.advanceTimersByTimeAsync(10);
  expect(process.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  process.emit("exit", null, "SIGKILL");
  await stopping;
  expect(vi.getTimerCount()).toBe(0);
});

test("a child that never confirms exit rejects rather than hanging", async () => {
  vi.useFakeTimers();
  const process = child();
  const stopping = expect(stopDesktopProcess(process as unknown as ChildProcess, 10)).rejects.toThrow(
    "did not exit",
  );
  await vi.advanceTimersByTimeAsync(20);
  await stopping;
  expect(process.listenerCount("exit")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("signal errors remove the listener and timer", async () => {
  vi.useFakeTimers();
  const process = child();
  process.kill.mockImplementation(() => {
    throw new Error("signal denied");
  });
  await expect(stopDesktopProcess(process as unknown as ChildProcess)).rejects.toThrow("signal denied");
  expect(process.listenerCount("exit")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
