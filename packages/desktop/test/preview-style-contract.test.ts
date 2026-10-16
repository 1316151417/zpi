import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const workbench = readFileSync(new URL("../src/renderer/workbench.css", import.meta.url), "utf8");
const shared = readFileSync(new URL("../../ui/src/styles.css", import.meta.url), "utf8");
function declarations(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "g"))].map((match) => match[1]);
}

test("diff navigation styles cannot leak into the shared breadcrumb nav", () => {
  for (const css of [workbench, shared]) {
    expect(css).not.toMatch(/\.diff-layout\s+nav\b/);
    expect(declarations(css, ".diff-layout > .diff-file-list")).toHaveLength(1);
  }
  const [breadcrumb] = declarations(workbench, ".preview-breadcrumb");
  expect(breadcrumb).toContain("overflow-x: auto");
  expect(breadcrumb).toContain("scrollbar-width: none");
  expect(breadcrumb).not.toMatch(/border|max-height|padding/);
});

test("preview code keeps ZCode defaults without duplicate font overrides", () => {
  const viewer = declarations(workbench, ".file-text-preview > diffs-container");
  expect(viewer).toHaveLength(1);
  expect(viewer[0]).toContain("--diffs-font-size: 12px");
  expect(viewer[0]).toContain("--diffs-line-height: 20px");
  expect(viewer[0]).toContain("--diffs-font-family: var(--font-code)");
  expect(declarations(shared, ".tool-diff-lines")[0]).toContain("font: 12px / 1.625 var(--font-code)");
});

test("file tabs fade filename and neutral Diff badge together around the close button", () => {
  expect(declarations(workbench, ".pane-tab-content")[0]).toContain("mask-image: linear-gradient");
  expect(declarations(workbench, ".pane-tab-title")[0]).toContain("flex-shrink: 0");
  expect(workbench).not.toContain(".pane-tab-trigger span {");
  const [badge] = declarations(workbench, ".pane-tab-trigger .pane-tab-diff-badge");
  expect(badge).toContain("background: var(--color-fill)");
  expect(badge).toContain("font-size: var(--text-xs)");
});
