import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskGroupToolbar } from "../src/renderer/TaskGroups.tsx";
import { TaskViewMenu } from "../src/renderer/TaskViewMenu.tsx";
import { emptyTaskGroups, type TaskGroupState } from "../src/shared/task-groups.ts";

function toolbar(groupIds: string[], collapsed: string[]) {
  const state: TaskGroupState = {
    ...emptyTaskGroups(),
    groups: groupIds.map((id) => ({ id, title: id, color: "gray", createdAt: 0 })),
  };
  return renderToStaticMarkup(
    createElement(TaskGroupToolbar, { state, collapsed, onToggleAll() {}, onCreate() {} }),
  );
}

describe("grouped task toolbar", () => {
  it("keeps a disabled expand button before create when no groups exist", () => {
    const html = toolbar([], []);
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain('aria-label="展开全部"');
    expect(buttons[0]).toContain('disabled=""');
    expect(html).toContain("lucide-maximize-2");
    expect(buttons[1]).toContain('aria-label="新建分组"');
    expect(buttons[1]).not.toContain("disabled");
  });

  it.each([
    { collapsed: [], label: "收起全部", icon: "minimize-2" },
    { collapsed: ["removed"], label: "收起全部", icon: "minimize-2" },
    { collapsed: ["a"], label: "展开全部", icon: "maximize-2" },
    { collapsed: ["a", "b"], label: "展开全部", icon: "maximize-2" },
  ])("renders the enabled $label action for $collapsed", ({ collapsed, label, icon }) => {
    const html = toolbar(["a", "b"], collapsed);
    const button = html.match(/<button\b[^>]*>/)?.[0];
    expect(button).toContain(`aria-label="${label}"`);
    expect(button).not.toContain("disabled");
    expect(html).toContain(`lucide-${icon}`);
  });
});

it.each(["grouped", "project", "chronological"] as const)(
  "keeps group/project order and the selected primary tab for %s",
  (organizeBy) => {
    const html = renderToStaticMarkup(
      createElement(TaskViewMenu, {
        value: { organizeBy, sortBy: "updated" },
        onChange() {},
        viewOnly: true,
      }),
    );
    expect(html).toContain('aria-label="组织任务"');
    expect(html.indexOf("分组")).toBeLessThan(html.indexOf("项目"));
    expect(html.match(/aria-pressed="(true|false)"/g)).toEqual([
      `aria-pressed="${organizeBy === "grouped"}"`,
      `aria-pressed="${organizeBy !== "grouped"}"`,
    ]);
    expect(html.match(/width="12" height="12"/g)).toHaveLength(2);
  },
);
