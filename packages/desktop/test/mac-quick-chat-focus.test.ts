import { beforeEach, expect, test, vi } from "vitest";

import { macQuickChatFocus } from "../src/main/mac-quick-chat-focus.ts";

const load = vi.fn();

beforeEach(() => {
  load.mockReset();
});

test("missing native focus support cannot prevent startup and logs once before falling back", () => {
  load.mockImplementation(() => {
    throw new Error("module unavailable");
  });
  const fallback = vi.fn();
  const report = vi.fn();
  const activate = macQuickChatFocus("/missing/native", fallback, report, load);
  expect(load).not.toHaveBeenCalled();
  expect(activate()).toBeUndefined();
  activate();
  expect(fallback).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "module unavailable" }));
});

test("native focus is loaded once from the unpacked path and preserves its focus owner", () => {
  const restore = vi.fn();
  const native = vi.fn().mockReturnValue(restore);
  load.mockReturnValue({ activate: native });
  const fallback = vi.fn();
  const report = vi.fn();
  const activate = macQuickChatFocus("/app.asar/native", fallback, report, load);
  expect(activate()).toBe(restore);
  activate();
  expect(load).toHaveBeenCalledExactlyOnceWith("/app.asar.unpacked/native/quick-chat-focus.node");
  expect(native).toHaveBeenCalledTimes(2);
  expect(fallback).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

test.each([
  undefined,
  {},
  { activate: 1 },
  { activate: () => "invalid owner" },
  {
    activate: () => {
      throw new Error("activation unavailable");
    },
  },
])("invalid native exports or activation failures are isolated (%j)", (binding) => {
  load.mockReturnValue(binding);
  const fallback = vi.fn();
  const report = vi.fn();
  const activate = macQuickChatFocus("/native", fallback, report, load);
  expect(() => activate()).not.toThrow();
  expect(fallback).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledOnce();
});
