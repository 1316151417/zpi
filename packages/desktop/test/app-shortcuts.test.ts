import { expect, it } from "vitest";
import { visiblePinnedTasks, workspaceShortcutForEvent } from "../src/renderer/app-shortcuts.ts";
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
  expect(workspaceShortcutForEvent({ key: "l", ctrlKey: true }, "linux", settings)).toBeUndefined();
  expect(
    workspaceShortcutForEvent({ key: "j", ctrlKey: true, isComposing: true }, "linux", settings),
  ).toBeUndefined();
  expect(
    workspaceShortcutForEvent({ key: "j", ctrlKey: true }, "linux", { ...settings, enabled: false }),
  ).toBeUndefined();
});
