import { expect, test } from "vitest";
import {
  floatingAnchors,
  floatingAnswerPreview,
  floatingPosition,
  nearestFloatingAnchor,
} from "../src/renderer/pane-full-view.ts";
import { defaultShortcuts, withAddedShortcuts } from "../src/shared/shortcuts.ts";

test("full-view geometry snaps to the same seven anchors and stays inside its workspace slot", () => {
  const slot = { left: 4, top: 52, width: 1000, height: 800 },
    size = { width: 560, height: 300 };
  for (const anchor of floatingAnchors) {
    const point = floatingPosition(anchor, slot, size);
    expect(point.left).toBeGreaterThanOrEqual(slot.left);
    expect(point.top).toBeGreaterThanOrEqual(slot.top);
    expect(point.left + size.width).toBeLessThanOrEqual(slot.left + slot.width);
    expect(point.top + size.height).toBeLessThanOrEqual(slot.top + slot.height);
    expect(nearestFloatingAnchor(point, slot, size)).toBe(anchor);
  }
  expect(
    floatingPosition("bottom-right", { left: 0, top: 0, width: 48, height: 48 }, { width: 48, height: 48 }),
  ).toEqual({ left: 0, top: 0 });
});
test("answer previews remove Markdown syntax without damaging snake_case", () => {
  expect(
    floatingAnswerPreview("# Done\n\n**updated** `snake_case` [file](file.ts)\n```ts\nignored\n```"),
  ).toBe("Done updated snake_case file");
});
test("the full-view shortcut uses the reference default and preserves cleared or conflicting bindings", () => {
  const settings = defaultShortcuts("darwin");
  expect(settings.bindings["pane-full-view"]).toBe("Shift+Command+F");
  Reflect.deleteProperty(settings.bindings, "pane-full-view");
  expect(withAddedShortcuts(settings, "darwin").bindings["pane-full-view"]).toBe("Shift+Command+F");
  settings.bindings.search = "Command+Shift+F";
  expect(withAddedShortcuts(settings, "darwin").bindings["pane-full-view"]).toBeNull();
  settings.bindings["pane-full-view"] = null;
  expect(withAddedShortcuts(settings, "darwin")).toBe(settings);
});
