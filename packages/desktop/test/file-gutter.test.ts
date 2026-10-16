import { afterEach, expect, it, vi } from "vitest";
import { fileGutterCSS, fileGutterLabel, observeFileGutterLabels } from "../src/renderer/file-gutter.ts";

function fixture() {
  const button = { setAttribute: vi.fn(), removeAttribute: vi.fn() };
  const shadow = { querySelectorAll: vi.fn((selector: string) => (selector === "*" ? [] : [button])) };
  const root = {
    isConnected: true,
    querySelectorAll: vi.fn((selector: string) => (selector === "*" ? [{ shadowRoot: shadow }] : [])),
  };
  const callbacks: Array<() => void> = [];
  const observers: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: () => void) {
        callbacks.push(callback);
        observers.push(this);
      }
    },
  );
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  const request = vi.fn((callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  const cancel = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  return { button, root, shadow, callbacks, observers, frames, request, cancel, flush };
}
afterEach(() => vi.unstubAllGlobals());
it("labels native shadow gutter controls without replacing their drag behavior", () => {
  const f = fixture();
  const stop = observeFileGutterLabels(f.root as unknown as HTMLElement);
  expect(f.button.setAttribute).toHaveBeenCalledWith("aria-label", fileGutterLabel);
  expect(f.button.removeAttribute).toHaveBeenCalledWith("title");
  expect(f.button.setAttribute).not.toHaveBeenCalledWith("title", expect.anything());
  expect(f.observers).toHaveLength(2);
  f.flush();
  f.callbacks[1]();
  f.callbacks[1]();
  expect(f.frames.size).toBe(1);
  f.flush();
  expect(f.observers).toHaveLength(2);
  stop();
  expect(f.observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
});
it("cancels pending work on detach and ignores subsequent observer delivery", () => {
  const f = fixture();
  const stop = observeFileGutterLabels(f.root as unknown as HTMLElement);
  f.button.setAttribute.mockClear();
  f.root.isConnected = false;
  f.flush();
  expect(f.button.setAttribute).not.toHaveBeenCalled();
  f.callbacks[0]();
  expect(f.frames.size).toBe(1);
  stop();
  expect(f.frames.size).toBe(0);
  f.callbacks[0]();
  expect(f.frames.size).toBe(0);
  expect(f.cancel).toHaveBeenCalled();
});
it("keeps the visual tooltip anchored to the native button and non-interactive", () => {
  expect(fileGutterCSS).toContain("[data-utility-button]::after");
  expect(fileGutterCSS).toContain(`content:${JSON.stringify(fileGutterLabel)}`);
  expect(fileGutterCSS).toContain("pointer-events:none;opacity:0");
  expect(fileGutterCSS).toContain(":focus-visible::after{opacity:1;}");
  expect(fileGutterCSS).not.toContain("position:fixed");
});
