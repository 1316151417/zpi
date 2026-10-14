import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { workspaceShortcutBlocked } from "../src/renderer/app-shortcuts.ts";
import { composerShortcutCommand } from "../src/renderer/composer-shortcuts.ts";
import { hasVisibleShortcutBlocker } from "../src/renderer/shortcut-context.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

const querySelectorAll = vi.fn<() => unknown[]>();
function blocker({ hiddenTree = false, rendered = true, visibility = "visible" } = {}) {
  return {
    visibility,
    closest: vi.fn(() => (hiddenTree ? {} : null)),
    getClientRects: () => (rendered ? [{}] : []),
  };
}
beforeEach(() => {
  querySelectorAll.mockReturnValue([]);
  vi.stubGlobal("document", { querySelectorAll });
  vi.stubGlobal("getComputedStyle", (element: { visibility: string }) => element);
});
afterEach(() => vi.unstubAllGlobals());

it.each([{ hiddenTree: true }, { rendered: false }, { visibility: "hidden" }, { visibility: "collapse" }])(
  "ignores a retained overlay that is not visible: %j",
  (options) => {
    const element = blocker(options);
    querySelectorAll.mockReturnValue([element]);
    expect(hasVisibleShortcutBlocker('[role="dialog"]')).toBe(false);
    expect(element.closest).toHaveBeenCalledWith('[hidden], [inert], [aria-hidden="true"]');
  },
);

it("still blocks when a visible dialog follows a hidden retained question", () => {
  querySelectorAll.mockReturnValue([blocker({ hiddenTree: true }), blocker()]);
  expect(hasVisibleShortcutBlocker('[role="dialog"]')).toBe(true);
});

it("allows workspace and focused composer shortcuts while an auxiliary question is hidden", () => {
  querySelectorAll.mockReturnValue([blocker({ hiddenTree: true })]);
  for (const command of ["toggle-sidebar", "toggle-pane", "new-task", "pin-1", "search", "find"] as const)
    expect(workspaceShortcutBlocked(command)).toBe(false);
  for (const [key, command] of [
    ["Enter", "send-next"],
    ["l", "select-model"],
  ]) {
    const event = { key, ctrlKey: true, keyCode: key === "Enter" ? 13 : 76 } as KeyboardEvent;
    expect(composerShortcutCommand(event, "linux", defaultShortcuts("linux"))).toBe(command);
  }
});

it("keeps visible dialog guards and the task-find exception unchanged", () => {
  querySelectorAll.mockReturnValue([blocker()]);
  expect(workspaceShortcutBlocked("toggle-sidebar")).toBe(true);
  expect(
    composerShortcutCommand(
      { key: "Enter", ctrlKey: true } as KeyboardEvent,
      "linux",
      defaultShortcuts("linux"),
    ),
  ).toBeUndefined();
  workspaceShortcutBlocked("find");
  expect(querySelectorAll).toHaveBeenLastCalledWith(
    expect.stringContaining('[role="dialog"]:not(.task-find-bar)'),
  );
});
