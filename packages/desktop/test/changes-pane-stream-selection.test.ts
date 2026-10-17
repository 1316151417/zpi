import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ViewBlock } from "zpi-ui";

type ToolBlock = Extract<ViewBlock, { type: "tool" }>;
const harness = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  selected: false,
  incoming: undefined as ToolBlock | undefined,
  root: {
    ownerDocument: {
      getSelection: () => ({
        get isCollapsed() {
          return !harness.selected;
        },
        rangeCount: 1,
        getRangeAt: () => ({ intersectsNode: () => true }),
      }),
    },
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values)) harness.values[index] = initial;
    return [
      harness.values[index],
      (value: unknown) => {
        harness.values[index] = typeof value === "function" ? value(harness.values[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values))
      harness.values[index] = { current: initial === null ? harness.root : initial };
    return harness.values[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
}));
vi.mock("zpi-ui", async () => ({
  ...(await import("../../ui/src/components/use-selection-stable-value.ts")),
  ToolFilePreview: () => null,
  DiffView: () => null,
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: () => harness.incoming,
  unwrap: (value: unknown) => value,
}));
vi.mock("../src/renderer/pane-store.ts", () => ({ openFile: vi.fn(), paneTask: vi.fn() }));
vi.mock("../src/renderer/PreviewHeader.tsx", () => ({ PreviewHeader: () => null }));

import { DiffView, ToolFilePreview } from "zpi-ui";
import { ChangesPane } from "../src/renderer/ChangesPane.tsx";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
const initial: ToolBlock = {
  type: "tool",
  id: "block",
  messageId: "message",
  toolCallId: "write",
  name: "write",
  status: "preparing",
  argsText: '{"path":"news.json","content":"selected prefix',
  output: "",
};
const props = { sessionId: "s", runId: "r", toolCallId: "write", path: "news.json", visible: true };
function render(overrides: Partial<typeof props> = {}) {
  harness.cursor = 0;
  return elements(ChangesPane({ ...props, ...overrides }));
}
function preview(nodes: Element[]) {
  return nodes.find((node) => node.type === ToolFilePreview);
}
beforeEach(() => {
  harness.values = [];
  harness.selected = false;
  harness.incoming = initial;
});

// This checks the actual component branch and hook with simulated selection,
// not browser DOM mutation or native clipboard behavior.
it("keeps the selected preview mounted across tool completion, then shows the final diff", () => {
  expect(preview(render())?.props.block).toBe(initial);
  harness.selected = true;
  harness.incoming = {
    ...initial,
    status: "completed",
    fileChange: { path: "news.json", patch: "@@\n+final" },
  };
  const frozen = render();
  expect(preview(frozen)?.props.block).toBe(initial);
  expect(frozen.some((node) => node.type === DiffView)).toBe(false);
  harness.selected = false;
  const released = render();
  expect(preview(released)).toBeUndefined();
  expect(released.some((node) => node.props.children === "加载变更…")).toBe(true);
});

it("retains the selected prefix through cancellation and shows the latest result on release", () => {
  render();
  harness.selected = true;
  harness.incoming = { ...initial, status: "error", output: "Interrupted" };
  expect(preview(render())?.props.block).toBe(initial);
  harness.selected = false;
  expect(preview(render())?.props.block).toBe(harness.incoming);
});

it.each([
  { sessionId: "other-session" },
  { runId: "other-run" },
  { toolCallId: "other-tool" },
  { path: "other.json" },
])("does not carry a frozen preview into a changed scope %j", (scope) => {
  render();
  harness.selected = true;
  harness.incoming = { ...initial, id: "next-block", argsText: '{"content":"new scope' };
  expect(preview(render(scope))?.props.block).toBe(harness.incoming);
});

it("keeps the newest incoming block available after many selected stream updates", () => {
  render();
  harness.selected = true;
  for (let index = 0; index < 100; index++) {
    harness.incoming = { ...initial, argsText: `${initial.argsText}${index}` };
    expect(preview(render())?.props.block).toBe(initial);
  }
  harness.selected = false;
  expect(preview(render())?.props.block).toBe(harness.incoming);
});
