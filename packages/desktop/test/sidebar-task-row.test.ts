import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionHint } from "zpi-ui";
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

function hints(node: ReactNode): Array<{ label: string; hideWhenDetached?: boolean }> {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode; label: string; hideWhenDetached?: boolean }>(child))
      return [];
    return child.type === ActionHint ? [child.props] : hints(child.props.children);
  });
}

it.each([
  { variant: "default", running: false },
  { variant: "default", running: true },
  { variant: "timeline", running: false },
  { variant: "timeline", running: true },
] as const)("hides detached archive hints for $variant, running=$running", ({ variant, running }) => {
  const tree = SidebarTaskRow({
    record: { ...record, running },
    active: false,
    workspace: "ZPI",
    pinLimitReached: false,
    variant,
    onSelect() {},
    onPin() {},
    onArchive() {},
  });
  const archive = hints(tree).find((hint) => hint.label === (running ? "请先停止运行" : "归档任务"));
  expect(archive?.hideWhenDetached).toBe(true);
  expect(hints(tree).find((hint) => hint.label === "取消置顶任务")?.hideWhenDetached).toBeUndefined();
  expect(row(undefined, { running }, variant)).toContain(
    `aria-label="归档任务 Pinned task"${running ? ' disabled=""' : ""}`,
  );
});
