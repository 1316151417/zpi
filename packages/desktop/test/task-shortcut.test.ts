import { expect, it } from "vitest";
import { taskShortcut } from "../src/renderer/task-shortcut.ts";

function keydown(properties: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return Object.assign(new Event("keydown", { cancelable: true }), {
    key: "n",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    repeat: false,
    ...properties,
  }) as KeyboardEvent;
}

it.each([
  { platform: "darwin", key: "n", metaKey: true, ctrlKey: false },
  { platform: "darwin", key: "N", metaKey: true, ctrlKey: false },
  { platform: "win32", key: "n", metaKey: false, ctrlKey: true },
  { platform: "linux", key: "n", metaKey: false, ctrlKey: true },
])("recognizes the new-task shortcut on $platform with $key", ({ platform, ...properties }) => {
  expect(taskShortcut(keydown(properties), platform)).toBe("new-task");
});

it.each([
  { platform: "darwin", metaKey: false, ctrlKey: true },
  { platform: "win32", metaKey: true, ctrlKey: false },
  { platform: "linux", metaKey: true, ctrlKey: false },
])("preserves non-command N bindings on $platform", ({ platform, ...properties }) => {
  expect(taskShortcut(keydown(properties), platform)).toBeUndefined();
});

it.each([
  { key: "k", metaKey: true, ctrlKey: false },
  { key: "K", metaKey: false, ctrlKey: true },
  { key: "k", repeat: true },
])("preserves the search shortcut: %j", (properties) => {
  for (const platform of ["darwin", "win32", "linux"])
    expect(taskShortcut(keydown(properties), platform)).toBe("search");
});

it.each(["n", "k"])("ignores modified, composing and already handled %s shortcuts", (key) => {
  for (const properties of [
    { metaKey: false, ctrlKey: false },
    { altKey: true },
    { shiftKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ])
    expect(taskShortcut(keydown({ key, ...properties }), "darwin")).toBeUndefined();
  const handled = keydown({ key });
  handled.preventDefault();
  expect(taskShortcut(handled, "darwin")).toBeUndefined();
});

it("ignores held new-task keys and unrelated shortcuts", () => {
  expect(taskShortcut(keydown({ repeat: true }), "darwin")).toBeUndefined();
  expect(taskShortcut(keydown({ key: "f" }), "darwin")).toBeUndefined();
});
