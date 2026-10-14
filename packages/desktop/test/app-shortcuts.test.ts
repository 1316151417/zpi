import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureWorkspaceShortcut,
  listenShortcutModifier,
  pinnedTaskShortcut,
  visiblePinnedTasks,
  workspaceShortcutForEvent,
} from "../src/renderer/app-shortcuts.ts";
import type { SessionRecord } from "../src/shared/bridge.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

it("uses the displayed pinned order and excludes archived, draft and child sessions", () => {
  const records = [
    { id: "second", pinnedAt: 20 },
    { id: "archived", pinnedAt: 1, archivedAt: 1 },
    { id: "draft", pinnedAt: 2, draft: true },
    { id: "side", pinnedAt: 3, parentSessionId: "first" },
    { id: "unpinned" },
    { id: "first", pinnedAt: 10 },
  ] as SessionRecord[];
  expect(visiblePinnedTasks(records).map((record) => record.id)).toEqual(["first", "second"]);
  expect(records[0]?.id).toBe("second");
});

it("reserves held workspace commands from terminals but leaves composer commands local", () => {
  const settings = defaultShortcuts("linux");
  expect(workspaceShortcutForEvent({ key: "j", ctrlKey: true, repeat: true }, "linux", settings)).toBe(
    "toggle-sidebar",
  );
  expect(workspaceShortcutForEvent({ key: "Enter", ctrlKey: true }, "linux", settings)).toBeUndefined();
  expect(workspaceShortcutForEvent({ key: "l", ctrlKey: true }, "linux", settings)).toBe("toggle-pane");
  expect(workspaceShortcutForEvent({ key: "k", ctrlKey: true }, "linux", settings)).toBe("search");
  expect(
    workspaceShortcutForEvent({ key: ";", code: "Semicolon", ctrlKey: true }, "linux", settings),
  ).toBeUndefined();
  expect(
    workspaceShortcutForEvent({ key: "j", ctrlKey: true, isComposing: true }, "linux", settings),
  ).toBeUndefined();
  expect(
    workspaceShortcutForEvent({ key: "j", ctrlKey: true }, "linux", { ...settings, enabled: false }),
  ).toBeUndefined();
});

afterEach(() => vi.unstubAllGlobals());

function focusKey(platform: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, {
    key: "i",
    code: "KeyI",
    keyCode: 73,
    metaKey: platform === "darwin",
    ctrlKey: platform !== "darwin",
    altKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    ...overrides,
  });
  return event as KeyboardEvent;
}

describe.each(["darwin", "linux"])("focus composer capture on %s", (platform) => {
  it("consumes the command before editor italic or terminal Tab input, and consumes held keys once", () => {
    vi.stubGlobal("document", { querySelectorAll: () => [] });
    const run = vi.fn();
    const settings = defaultShortcuts(platform);
    for (const repeat of [false, true]) {
      const event = focusKey(platform, { repeat });
      captureWorkspaceShortcut(event, platform, settings, run);
      expect(event.defaultPrevented).toBe(true);
      expect(event.cancelBubble).toBe(true);
    }
    expect(run).toHaveBeenCalledExactlyOnceWith("focus-composer");
  });

  it.each([
    "disabled",
    "unbound",
    "remapped",
    "ime",
    "229",
    "composing",
    "handled",
    "alt",
    "shift",
    "blocked",
  ])("preserves local input without dispatch when %s", (mode) => {
    vi.stubGlobal("document", {
      querySelectorAll: () =>
        mode === "blocked" ? [{ closest: () => null, getClientRects: () => [{}] }] : [],
    });
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
    const settings = defaultShortcuts(platform);
    if (mode === "disabled") settings.enabled = false;
    if (mode === "unbound") settings.bindings["focus-composer"] = null;
    if (mode === "remapped")
      settings.bindings["focus-composer"] = platform === "darwin" ? "Command+U" : "Control+U";
    const event = focusKey(platform, {
      isComposing: mode === "ime",
      keyCode: mode === "229" ? 229 : 73,
      altKey: mode === "alt",
      shiftKey: mode === "shift",
    });
    if (mode === "handled") event.preventDefault();
    const run = vi.fn();
    captureWorkspaceShortcut(event, platform, settings, run, mode === "composing");
    expect(run).not.toHaveBeenCalled();
    expect(event.cancelBubble).toBe(false);
    expect(event.defaultPrevented).toBe(mode === "handled");
    if (mode === "remapped") {
      const remapped = focusKey(platform, { key: "u", code: "KeyU" });
      captureWorkspaceShortcut(remapped, platform, settings, run);
      expect(run).toHaveBeenCalledExactlyOnceWith("focus-composer");
      expect(remapped.defaultPrevented).toBe(true);
    }
  });

  it("reads native KeyboardEvent prototype properties rather than spreading them", () => {
    const event = Object.create(
      Object.defineProperties(
        {},
        {
          key: { get: () => "i" },
          code: { get: () => "KeyI" },
          metaKey: { get: () => platform === "darwin" },
          ctrlKey: { get: () => platform !== "darwin" },
        },
      ),
    );
    expect(Object.keys(event)).toEqual([]);
    expect(workspaceShortcutForEvent(event, platform, defaultShortcuts(platform))).toBe("focus-composer");
  });
});

describe.each(["darwin", "linux", "win32"])("pinned shortcut hints on %s", (platform) => {
  it("uses the actual configured bindings for only the first five displayed tasks", () => {
    const settings = defaultShortcuts(platform);
    for (let index = 0; index < 5; index++) {
      expect(pinnedTaskShortcut(index, settings, platform)).toBe(
        `${platform === "darwin" ? "⌘" : "Ctrl+"}${index + 1}`,
      );
    }
    for (const index of [-1, 5, 6]) expect(pinnedTaskShortcut(index, settings, platform)).toBe("");
    settings.bindings["pin-2"] = "Alt+Shift+Q";
    expect(pinnedTaskShortcut(1, settings, platform)).toBe(platform === "darwin" ? "⌥⇧Q" : "Alt+Shift+Q");
    settings.bindings["pin-2"] = null;
    expect(pinnedTaskShortcut(1, settings, platform)).toBe("");
    settings.enabled = false;
    expect(pinnedTaskShortcut(0, settings, platform)).toBe("");
  });

  it("tracks held modifiers without consuming input and resets on release, blur and visibility", () => {
    const target = new EventTarget();
    const document = new EventTarget();
    vi.stubGlobal("window", target);
    vi.stubGlobal("document", document);
    const change = vi.fn();
    const dispose = listenShortcutModifier(platform, change);
    const dispatch = (type: string, held: boolean, overrides = {}) => {
      const event = new Event(type, { cancelable: true });
      Object.assign(event, {
        metaKey: platform === "darwin" && held,
        ctrlKey: platform !== "darwin" && held,
        ...overrides,
      });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(event.cancelBubble).toBe(false);
    };
    dispatch("keydown", true);
    expect(change).toHaveBeenLastCalledWith(true);
    // Repeat, IME and other key releases must not clear a modifier that remains held.
    dispatch("keydown", true, { repeat: true, isComposing: true });
    dispatch("keyup", true);
    expect(change).toHaveBeenLastCalledWith(true);
    dispatch("keyup", false);
    expect(change).toHaveBeenLastCalledWith(false);
    dispatch("keydown", true);
    target.dispatchEvent(new Event("blur"));
    expect(change).toHaveBeenLastCalledWith(false);
    dispatch("keydown", true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(change).toHaveBeenLastCalledWith(false);
    dispatch("keydown", false, platform === "darwin" ? { ctrlKey: true } : { metaKey: true });
    expect(change).toHaveBeenLastCalledWith(false);
    dispose();
    change.mockClear();
    dispatch("keydown", true);
    dispatch("keyup", false);
    target.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(change).not.toHaveBeenCalled();
  });
});
