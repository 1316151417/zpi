import * as Popover from "@radix-ui/react-popover";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  effects: [] as (() => (() => void) | undefined)[],
}));
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
  useEffect: (effect: () => (() => void) | undefined) => {
    hooks.effects.push(effect);
  },
  useId: () => "source-title",
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
}));

import { AnswerSourceIcon, AnswerSourceList, AnswerSources } from "../src/components/AnswerSources.tsx";
import type { AnswerSource } from "../src/components/answer-sources.ts";
import { RunGroup } from "../src/components/Conversation.tsx";
import { CopyMessage } from "../src/components/MessageActions.tsx";
import type { RunView } from "../src/types.ts";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6i0AAAAASUVORK5CYII=";
const source: AnswerSource = {
  url: "https://example.com/article",
  hostname: "example.com",
  siteName: "Example",
  title: "Article",
  siteIcon: "https://example.com/icon.png",
  excerpt: "A short excerpt",
  date: "Today",
};
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element as ReactElement<Record<string, unknown>>, ...elements(element.props.children)];
}
function component<T>(render: (props: T) => ReactNode, props: T) {
  hooks.cursor = 0;
  hooks.effects = [];
  return elements(render(props));
}
function find(nodes: ReturnType<typeof elements>, type: unknown) {
  const node = nodes.find((node) => node.type === type);
  if (!node) throw new Error(`Missing element ${String(type)}`);
  return node;
}
function call(props: Record<string, unknown>, name: string, value?: unknown) {
  (props[name] as (value?: unknown) => void)(value);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
});

test("controlled Radix state opens and closes without suppressing keyboard, outside dismissal or focus", () => {
  const render = () => component(AnswerSources, { sources: [source], runId: "r", onLink: vi.fn() });
  let nodes = render();
  const root = find(nodes, Popover.Root);
  expect(root.props.open).toBe(false);
  expect(find(nodes, AnswerSourceIcon).props.refresh).toBe(false);
  call(root.props, "onOpenChange", true);
  nodes = render();
  expect(find(nodes, Popover.Root).props.open).toBe(true);
  expect(find(nodes, AnswerSourceIcon).props.refresh).toBe(true);
  const content = find(nodes, Popover.Content);
  expect(content.props["aria-labelledby"]).toBe("source-title");
  for (const callback of ["onOpenAutoFocus", "onCloseAutoFocus", "onEscapeKeyDown", "onInteractOutside"])
    expect(content.props[callback]).toBeUndefined();
  expect(find(nodes, Popover.Trigger).props.asChild).toBe(true);
  expect(find(nodes, Popover.Close).props["aria-label"]).toBe("关闭来源");
  call(find(nodes, Popover.Root).props, "onOpenChange", false);
  expect(find(render(), Popover.Root).props.open).toBe(false);
  call(find(render(), Popover.Root).props, "onOpenChange", true);
  call(find(render(), AnswerSourceList).props, "onOpenSource");
  expect(find(render(), Popover.Root).props.open).toBe(false);
});

test("source click revalidates the current destination, forces in-app navigation and closes only on success", () => {
  const current = { ...source };
  const onLink = vi.fn(),
    onOpenSource = vi.fn();
  const nodes = component(AnswerSourceList, { sources: [current], runId: "r", onLink, onOpenSource });
  const button = find(nodes, "button");
  call(button.props, "onClick");
  expect(onLink).toHaveBeenCalledExactlyOnceWith(source.url, { forceInApp: true });
  expect(onOpenSource).toHaveBeenCalledOnce();
  current.url = "javascript:evil()";
  call(button.props, "onClick");
  expect(onLink).toHaveBeenCalledOnce();
  expect(onOpenSource).toHaveBeenCalledOnce();
});

test("icons render a globe until validated PNG data arrives and fall back on decode error or lost reader", async () => {
  const readIcon = vi.fn(async () => png);
  const props = { source, sessionId: "s", runId: "r", readIcon };
  let nodes = component(AnswerSourceIcon, props);
  expect(nodes.some((node) => node.type === "img")).toBe(false);
  hooks.effects[0]();
  await tick();
  nodes = component(AnswerSourceIcon, props);
  expect(find(nodes, "img").props.src).toBe(png);
  expect(readIcon).toHaveBeenCalledExactlyOnceWith("s", "r", source.url);
  expect(
    component(AnswerSourceIcon, { ...props, readIcon: undefined }).some((node) => node.type === "img"),
  ).toBe(false);
  call(find(nodes, "img").props, "onError");
  expect(component(AnswerSourceIcon, props).some((node) => node.type === "img")).toBe(false);
});

test.each(["https://tracker.example/icon.png", "data:image/svg+xml,<svg/>", undefined])(
  "untrusted loader result %# remains a globe",
  async (result) => {
    const props = { source, sessionId: "s", runId: "r", readIcon: vi.fn(async () => result) };
    component(AnswerSourceIcon, props);
    hooks.effects[0]();
    await tick();
    expect(component(AnswerSourceIcon, props).some((node) => node.type === "img")).toBe(false);
  },
);

test("unmounted and changed-source requests cannot display stale icons", async () => {
  let finish!: (value: string) => void;
  const props = {
    source,
    sessionId: "s",
    runId: "r",
    readIcon: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  component(AnswerSourceIcon, props);
  const cleanup = hooks.effects[0]();
  await tick();
  cleanup?.();
  finish(png);
  await tick();
  expect(hooks.values[0]).toBeUndefined();
  component(AnswerSourceIcon, props);
  hooks.effects[0]();
  await tick();
  expect(find(component(AnswerSourceIcon, props), "img").props.src).toBe(png);
  for (const changed of [
    { ...props, sessionId: "side-chat" },
    { ...props, runId: "another-run" },
    { ...props, source: { ...source, url: "https://example.com/new" } },
    { ...props, source: { ...source, siteIcon: "https://example.com/new-icon.png" } },
  ])
    expect(component(AnswerSourceIcon, changed).some((node) => node.type === "img")).toBe(false);
});

test("the parent keys popover state by session, run and answer and drops source controls on empty history", () => {
  const current: RunView = {
    runId: "same-run",
    status: "completed",
    userMessage: "Question",
    startedAt: 1,
    orderedBlocks: [
      {
        id: "search",
        messageId: "search-message",
        type: "tool",
        toolCallId: "call",
        name: "web_fetch",
        argsText: "{}",
        status: "completed",
        output: "BODY",
        web: {
          kind: "web_fetch",
          status: "success",
          url: source.url,
          content: "SOURCE_EXCERPT_MUST_NOT_COPY",
        },
      },
      { id: "answer", messageId: "answer-message", type: "text", text: "Answer" },
    ],
    finalAnswerBlockIds: ["answer"],
  };
  const render = (sessionId: string, run = current) =>
    component((RunGroup as unknown as { type: (props: ComponentProps<typeof RunGroup>) => ReactNode }).type, {
      run,
      sessionId,
      onLink: vi.fn(),
      expanded: false,
      onToggle: vi.fn(),
      blocks: {},
      onBlockToggle: vi.fn(),
    });
  const key = find(render("main"), AnswerSources).key;
  const copies = render("main").filter((node) => node.type === CopyMessage);
  expect(copies.at(-1)?.props.text).toBe("Answer");
  expect(copies.at(-1)?.props.text).not.toContain("SOURCE_EXCERPT_MUST_NOT_COPY");
  expect(find(render("main"), AnswerSources).props.sources).toMatchObject([
    { excerpt: "SOURCE_EXCERPT_MUST_NOT_COPY" },
  ]);
  expect(find(render("side-chat"), AnswerSources).key).not.toBe(key);
  expect(find(render("main", { ...current, runId: "forked-run" }), AnswerSources).key).not.toBe(key);
  const changedAnswer: RunView = {
    ...current,
    orderedBlocks: [
      current.orderedBlocks[0],
      { id: "new-answer", messageId: "new-message", type: "text", text: "New answer" },
    ],
    finalAnswerBlockIds: ["new-answer"],
  };
  expect(find(render("main", changedAnswer), AnswerSources).key).not.toBe(key);
  expect(
    render("main", { ...current, orderedBlocks: current.orderedBlocks.slice(1) }).some(
      (node) => node.type === AnswerSources,
    ),
  ).toBe(false);
});
