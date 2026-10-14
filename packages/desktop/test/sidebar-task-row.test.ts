import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SidebarTaskRow } from "../src/renderer/SidebarTaskRow.tsx";
import { formatTaskRelativeTime } from "../src/renderer/sidebar-task-model.ts";
import type { SessionRecord } from "../src/shared/bridge.ts";

const record = { id: "pinned", title: "Pinned task", pinnedAt: 1, updatedAt: 0 } as SessionRecord;
function row(
  shortcut?: string,
  overrides: Partial<SessionRecord> = {},
  variant: "default" | "timeline" = "default",
) {
  return renderToStaticMarkup(
    createElement(SidebarTaskRow, {
      record: { ...record, ...overrides },
      active: false,
      workspace: "ZPI",
      pinLimitReached: false,
      shortcut,
      variant,
      onSelect() {},
      onPin() {},
      onArchive() {},
    }),
  );
}

describe.each(["default", "timeline"] as const)("task row metadata in %s", (variant) => {
  it("replaces the time in its existing slot only while a shortcut is supplied", () => {
    for (const shortcut of [undefined, "", "⌘1", undefined]) {
      const html = row(shortcut, {}, variant);
      expect(html).toContain(`data-shortcut="${Boolean(shortcut)}"`);
      expect(html.includes("task-row-shortcut")).toBe(Boolean(shortcut));
      expect(html.includes(formatTaskRelativeTime(record.updatedAt))).toBe(!shortcut);
      if (shortcut) {
        expect(html).toContain('class="task-row-time" data-task-row-metadata="true"><kbd');
        expect(html).toContain("⌘1");
      }
    }
  });

  it("preserves the actionable question badge instead of replacing it with a shortcut", () => {
    const pendingQuestion = { id: "question" } as NonNullable<SessionRecord["pendingQuestion"]>;
    const html = row("⌘1", { pendingQuestion }, variant);
    expect(html).toContain("task-question-badge");
    expect(html).toContain("等待确认");
    expect(html).toContain('data-shortcut="false"');
    expect(html).not.toContain("task-row-shortcut");
  });
});
