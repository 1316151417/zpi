import * as HoverCard from "@radix-ui/react-hover-card";
import * as Popover from "@radix-ui/react-popover";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useEffect: () => {},
}));

import {
  SelectionReferenceChip,
  SelectionReferenceDetails,
} from "../src/components/ConversationSelections.tsx";

const reference = {
  path: "/file.txt",
  text: "source",
  sourceKey: 'file-comment:{"start":1,"end":1,"comment":"note"}',
};
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element as ReactElement<Record<string, unknown>>, ...elements(element.props.children)];
}
function render(comments = true, onChange = vi.fn()) {
  const chip = SelectionReferenceChip({ references: comments ? [reference] : [{ text: "quote" }], onChange });
  const group = elements(chip).find(
    (element) =>
      Array.isArray(element.props.references) && element.props.comments === (comments ? true : undefined),
  );
  if (!group || typeof group.type !== "function") throw new Error("Missing group");
  hooks.cursor = 0;
  const tree = (group.type as (props: unknown) => ReactNode)(group.props);
  const nodes = elements(tree);
  const root = nodes.find((node) => node.type === (comments ? Popover.Root : HoverCard.Root));
  const content = nodes.find((node) => node.type === (comments ? Popover.Content : HoverCard.Content));
  const trigger = nodes.find((node) => node.props.className === "selection-reference-chip");
  const details = nodes.find((node) => node.type === SelectionReferenceDetails);
  if (!root || !content || !trigger || !details) throw new Error("Missing popover controls");
  return { root: root.props, content: content.props, trigger: trigger.props, details: details.props };
}
function call(props: Record<string, unknown>, name: string, event: unknown = {}) {
  (props[name] as (event: unknown) => void)(event);
}
beforeEach(() => {
  hooks.values = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

test("hover previews neither steal nor restore focus and crossing the gap cancels pending dismissal", () => {
  call(render().trigger, "onPointerEnter", { pointerType: "mouse" });
  const hovered = render();
  expect(hovered.root.open).toBe(true);
  const preventDefault = vi.fn();
  call(hovered.content, "onOpenAutoFocus", { preventDefault });
  call(hovered.content, "onCloseAutoFocus", { preventDefault });
  expect(preventDefault).toHaveBeenCalledTimes(2);
  call(hovered.trigger, "onPointerLeave");
  call(hovered.content, "onPointerEnter");
  vi.advanceTimersByTime(150);
  expect(render().root.open).toBe(true);
  call(render().content, "onPointerLeave");
  vi.advanceTimersByTime(150);
  expect(render().root.open).toBe(false);
});

test("Enter upgrades a mounted hover preview to keyboard interaction with tabbable Popover controls", () => {
  call(render().trigger, "onPointerEnter", { pointerType: "mouse" });
  const hovered = render();
  const focus = vi.fn();
  (hovered.content.ref as { current: unknown }).current = { querySelector: () => ({ focus }) };
  const target = {};
  call(hovered.trigger, "onKeyDown", { key: "Enter", target, currentTarget: target, preventDefault() {} });
  expect(focus).toHaveBeenCalledOnce();
  const active = render();
  const preventDefault = vi.fn();
  call(active.content, "onOpenAutoFocus", { preventDefault });
  call(active.content, "onCloseAutoFocus", { preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
  call(active.content, "onPointerLeave");
  vi.advanceTimersByTime(150);
  expect(render().root.open).toBe(true);
  call(active.trigger, "onKeyDown", { key: "Escape", target, currentTarget: target });
  expect(render().root.open).toBe(false);
});

test("explicit pointer activation enables focus and deleting a comment closes the interactive panel", () => {
  const onChange = vi.fn();
  call(render(true, onChange).trigger, "onClick", { preventDefault() {} });
  const active = render(true, onChange);
  const preventDefault = vi.fn();
  call(active.content, "onOpenAutoFocus", { preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
  call(active.details, "onChange", []);
  expect(onChange).toHaveBeenCalledWith([]);
  expect(render().root.open).toBe(false);
});

test("ordinary quotations retain their existing HoverCard behavior", () => {
  const quote = render(false);
  expect(quote.content.onOpenAutoFocus).toBeUndefined();
  expect(quote.root.openDelay).toBe(0);
  call(quote.trigger, "onClick", {});
  expect(render(false).root.open).toBe(true);
});
