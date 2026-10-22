import { type ComponentProps, createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { DiffView } from "../src/components/DiffView.tsx";
import { useTextFind } from "../src/components/use-text-find.ts";

const hooks = vi.hoisted(() => ({
  stateIndex: 0,
  memoIndex: 0,
  states: [] as unknown[],
  memos: [] as { dependencies: unknown[]; value: unknown }[],
  theme: "light",
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (value: unknown) => (hooks.states[index] = value)];
  },
  useMemo: (factory: () => unknown, dependencies: unknown[]) => {
    const index = hooks.memoIndex++;
    const previous = hooks.memos[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
      hooks.memos[index] = { dependencies, value: factory() };
    }
    return hooks.memos[index].value;
  },
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
  useRef: () => ({ current: null }),
}));
vi.mock("../src/appearance.ts", () => ({ useAppearance: () => ({ theme: hooks.theme }) }));
vi.mock("../src/components/use-text-find.ts", () => ({ useTextFind: vi.fn(), findHighlightCSS: "" }));
vi.mock("../src/components/ToolDiff.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/components/ToolDiff.tsx")>()),
  useToolTokens: () => undefined,
}));
vi.mock("@pierre/diffs/react", () => ({ PatchDiff: () => null }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({ getVirtualItems: () => [], getTotalSize: () => 0 }),
}));

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element as ReactElement<Record<string, unknown>>, ...elements(element.props.children)];
}

it("reuses full single-side lines for find, focus, wrapping and theme while moving the 2,000-line window", () => {
  const patch = `--- /dev/null\n+++ large.txt\n@@ -0,0 +1,5000 @@\n${Array.from(
    { length: 5000 },
    (_, index) => `+content ${index + 1}\n`,
  ).join("")}`;
  const readPatch = vi.fn(() => patch);
  const entries = [
    {
      id: "large",
      path: "large.txt",
      status: "created",
      area: "working",
      get patch() {
        return readPatch();
      },
    },
  ];
  const props: ComponentProps<typeof DiffView> = {
    entries,
    loadPatch: async () => "",
    openFile: vi.fn(),
    renderHeader: () => createElement("header"),
    findRequest: { query: "content", activeIndex: 0, navigationId: 1 },
  };
  const render = () => {
    hooks.stateIndex = 0;
    hooks.memoIndex = 0;
    const tree = DiffView(props);
    const single = elements(tree).find((element) => Array.isArray(element.props.lines));
    expect(single).toBeDefined();
    return { lines: single?.props.lines, html: renderToStaticMarkup(single) };
  };
  const first = render();
  const find = vi.mocked(useTextFind).mock.calls.at(-1)?.[0];
  expect(find?.targets).toHaveLength(5000);
  expect(find?.targets?.[0]).toBe((first.lines as unknown[])[0]);
  expect(first.html).toContain("content 1</code>");
  expect(first.html).not.toContain("content 4001</code>");
  expect(readPatch).toHaveBeenCalledOnce();

  const target = find?.targets?.[4000];
  expect(target).toBeDefined();
  if (!target) throw new Error("Missing full-file find target");
  find?.onNavigate?.({ ...target, start: 0, end: 7 });
  props.wrap = true;
  hooks.theme = "dark";
  const focused = render();
  expect(focused.lines).toBe(first.lines);
  expect(focused.html).toContain("content 4001</code>");
  expect(focused.html).not.toContain("content 1</code>");
  expect(focused.html.match(/class="tool-diff-line added"/g)).toHaveLength(2000);
  expect(readPatch).toHaveBeenCalledOnce();

  props.entries = [{ ...entries[0], patch: patch.replace("content 4001", "changed 4001") }];
  const changed = render();
  expect(changed.lines).not.toBe(first.lines);
  expect(changed.html).toContain("changed 4001</code>");
});
