import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findHighlightLimit, useTextFind } from "../src/components/use-text-find.ts";
import type { FindRequest, FindTarget } from "../src/find.ts";

let container: HTMLDivElement, reactRoot: Root;
const rootRef = { current: null as HTMLDivElement | null };
const onStateChange = vi.fn(),
  onNavigate = vi.fn();
let frames: Map<number, FrameRequestCallback>,
  frameId = 0;
let highlights: Map<string, Highlight>;
const request = { query: "needle", activeIndex: 0, navigationId: 1 };

function Harness({
  children,
  find = request,
  scope = "session-a",
  targets,
  navigateUnmounted,
}: {
  children: ReactNode;
  find?: FindRequest;
  scope?: string;
  targets?: FindTarget[];
  navigateUnmounted?: boolean;
}) {
  useTextFind({
    rootRef,
    request: find,
    content: children,
    scopeKey: scope,
    targets,
    onStateChange,
    onNavigate,
    navigateUnmounted,
  });
  return createElement("div", { ref: rootRef }, children);
}
async function flush() {
  await act(async () => {
    // Let the real MutationObserver deliver DOM changes before running the queued animation frame.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = [...frames.values()];
    frames.clear();
    for (const frame of pending) frame(0);
  });
}
async function render(
  children: ReactNode,
  find = request,
  scope?: string,
  targets?: FindTarget[],
  navigateUnmounted?: boolean,
) {
  await act(async () =>
    reactRoot.render(createElement(Harness, { children, find, scope, targets, navigateUnmounted })),
  );
  await flush();
}
const all = () => highlights.get("zpi-conversation-find");
const active = () =>
  [...(highlights.get("zpi-conversation-find-active") ?? [])].map((range) => range.toString());
const row = (key: string, text: ReactNode) => createElement("div", { key, "data-find-key": key }, text);

beforeEach(() => {
  frames = new Map();
  frameId = 0;
  highlights = new Map();
  onStateChange.mockClear();
  onNavigate.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      priority = 0;
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  container = document.createElement("div");
  document.body.append(container);
  reactRoot = createRoot(container);
});
afterEach(async () => {
  await act(async () => reactRoot.unmount());
  container.remove();
  document.getElementById("zpi-find-style")?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reuses DOM text and all-hit highlights while navigation changes only the active range", async () => {
  const body = Array.from({ length: 200 }, (_, i) => row(`run-${i}`, "needle ".repeat(10)));
  const walk = vi.spyOn(document, "createTreeWalker");
  const ranges = vi.spyOn(document, "createRange");
  await render(body);
  expect(onStateChange).toHaveBeenLastCalledWith({ total: 2000, activeIndex: 0 });
  expect(walk).toHaveBeenCalledTimes(200);
  expect(ranges).toHaveBeenCalledTimes(2000);
  const initial = all();
  await render(body, { ...request, activeIndex: 1, navigationId: 2 });
  expect(active()).toEqual(["needle"]);
  expect(all()).toBe(initial);
  expect(walk).toHaveBeenCalledTimes(200);
  expect(ranges).toHaveBeenCalledTimes(2000);
  await render(body, { ...request, query: "need" });
  expect(active()).toEqual(["need"]);
  expect(walk).toHaveBeenCalledTimes(200);
});

it("invalidates only changed text even when React commits before the search effect cleanup", async () => {
  const body = (tail: string) => [row("old", "needle old"), row("tail", tail)];
  const walk = vi.spyOn(document, "createTreeWalker");
  await render(body("needle"));
  const stableRange = [...(all() ?? [])][0];
  await render(body("needle needle"));
  expect(onStateChange).toHaveBeenLastCalledWith({ total: 3, activeIndex: 0 });
  expect(walk).toHaveBeenCalledTimes(3);
  expect([...(all() ?? [])][0]).toBe(stableRange);
  expect([...(all() ?? [])].map((range) => range.toString())).toEqual(["needle", "needle", "needle"]);
  const tail = rootRef.current?.querySelector('[data-find-key="tail"]');
  if (!tail?.firstChild) throw new Error("Missing streamed text");
  tail.firstChild.textContent = "needle needle needle";
  await flush();
  expect(onStateChange).toHaveBeenLastCalledWith({ total: 4, activeIndex: 0 });
  expect(walk).toHaveBeenCalledTimes(4);
});

it("keeps rendered-text semantics across formatting, Unicode, hidden content and ignore changes", async () => {
  const body = [
    row("formatted", createElement("p", {}, "😀跨", createElement("strong", {}, "格式"), "匹配İ")),
    row("controls", createElement("button", {}, "needle")),
    row("link", createElement("button", { "data-conversation-inline-link": "true" }, "needle")),
    row("blocks", [createElement("p", { key: 1 }, "跨"), createElement("p", { key: 2 }, "格式")]),
  ];
  await render(body, { ...request, query: "跨格式匹配" });
  expect(active()).toEqual(["跨格式匹配"]);
  await render(body, { ...request, query: "İ" });
  expect(active()).toEqual(["İ"]);
  await render(body, request);
  expect(onStateChange).toHaveBeenLastCalledWith({ total: 1, activeIndex: 0 });
  const parent = rootRef.current;
  if (!parent) throw new Error("Missing search root");
  parent.setAttribute("hidden", "");
  await flush();
  expect(onStateChange).toHaveBeenLastCalledWith({ total: 0, activeIndex: -1 });
  parent.removeAttribute("hidden");
  await flush();
  expect(onStateChange).toHaveBeenLastCalledWith({ total: 1, activeIndex: 0 });
  parent.querySelector('[data-find-key="link"]')?.setAttribute("data-find-ignore", "");
  await flush();
  expect(onStateChange).toHaveBeenLastCalledWith({ total: 0, activeIndex: -1 });
});

it.each([undefined, "run"])("keeps manual folding separate from target identity (%s)", async (runId) => {
  await render(
    createElement("section", { hidden: true, "data-find-index": true }, row("folded", "needle")),
    request,
    undefined,
    [{ key: "folded", text: "needle", runId }],
    false,
  );
  expect(onStateChange).toHaveBeenLastCalledWith({ total: 1, activeIndex: 0 });
  expect(active()).toEqual([]);
  expect(onNavigate.mock.lastCall?.[1]).toBeUndefined();
  rootRef.current?.querySelector("section")?.removeAttribute("hidden");
  await flush();
  expect(active()).toEqual(["needle"]);
  const navigations = onNavigate.mock.calls.length;
  rootRef.current?.querySelector("section")?.setAttribute("hidden", "");
  await flush();
  expect(active()).toEqual([]);
  expect(onNavigate).toHaveBeenCalledTimes(navigations);
});

it("refreshes mounted diff ranges on shadow mutations while counting unmounted supplied targets", async () => {
  const targets = [
    { key: "file:0", text: "old needle" },
    { key: "file:1", text: "unmounted needle" },
  ];
  await render(
    createElement(
      "div",
      { "data-diff-id": "file" },
      createElement("diffs-container", {
        ref(node: HTMLElement | null) {
          if (node && !node.shadowRoot)
            node.attachShadow({ mode: "open" }).innerHTML =
              '<pre data-code><code data-line data-line-index="0">old needle</code></pre>';
        },
      }),
    ),
    request,
    undefined,
    targets,
  );
  expect(onStateChange).toHaveBeenLastCalledWith({ total: 2, activeIndex: 0 });
  expect(active()).toEqual(["needle"]);
  const line = rootRef.current?.querySelector("diffs-container")?.shadowRoot?.querySelector("code");
  if (!line) throw new Error("Missing rendered diff line");
  line.textContent = "new needle";
  await flush();
  expect(active()).toEqual(["needle"]);
  expect([...(all() ?? [])][0].startContainer.parentElement?.textContent).toBe("new needle");
  rootRef.current?.querySelector("diffs-container")?.remove();
  await flush();
  expect(all()?.size).toBe(0);
  onStateChange.mockClear();
  line.textContent = "detached needle";
  await flush();
  expect(onStateChange).not.toHaveBeenCalled();
});

it("clears cached DOM, matches and owned highlights when closing or changing scope", async () => {
  const body = row("same-key", "needle");
  const walk = vi.spyOn(document, "createTreeWalker");
  await render(body);
  await render(body, request, "session-b");
  expect(walk).toHaveBeenCalledTimes(2);
  await render(body, { ...request, query: "" }, "session-b");
  expect(highlights.size).toBe(0);
  await render(body, request, "session-b");
  expect(walk).toHaveBeenCalledTimes(3);
  await act(async () => reactRoot.unmount());
  expect(highlights.size).toBe(0);
  expect(frames.size).toBe(0);
  reactRoot = createRoot(container);
});

it("ignores preview dialogs and routing errors when locating a later projected match", async () => {
  const body = row("answer", [
    createElement("p", { key: 0 }, "before"),
    createElement("dialog", { key: 1, open: true }, "preview controls needle"),
    createElement("span", { key: 2, "data-find-ignore": true }, "routing error"),
    createElement("p", { key: 3 }, "needle"),
  ]);
  await render(body, request, undefined, [{ key: "answer", text: "before\nneedle" }]);
  expect(active()).toEqual(["needle"]);
  expect(onStateChange).toHaveBeenLastCalledWith({ total: 1, activeIndex: 0 });
});

it("uses rendered fallback text instead of stale Markdown projection offsets", async () => {
  await render(
    row("answer", createElement("div", { "data-find-rendered": true }, "**needle**")),
    request,
    undefined,
    [{ key: "answer", text: "needle" }],
  );
  expect(active()).toEqual(["needle"]);
});

it("requests an unmounted match once, then refines it when its range appears", async () => {
  const targets = [{ key: "offscreen", text: "needle", runId: "run" }];
  await render(row("other", "unrelated"), request, undefined, targets, false);
  expect(onNavigate).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 3; i++) {
    rootRef.current?.append(document.createElement("span"));
    await flush();
  }
  expect(onNavigate).toHaveBeenCalledTimes(1);
  await render(row("offscreen", "needle"), request, undefined, targets, false);
  expect(onNavigate).toHaveBeenCalledTimes(2);
  expect(active()).toEqual(["needle"]);
});

it("bounds painted ranges without truncating results or losing navigation to the last match", async () => {
  const count = 70_000;
  await render(row("many", "needle ".repeat(count)), { ...request, activeIndex: count - 1 });
  expect(onStateChange).toHaveBeenLastCalledWith({ total: count, activeIndex: count - 1 });
  expect(all()?.size).toBe(findHighlightLimit);
  expect(active()).toEqual(["needle"]);
  expect(onNavigate.mock.lastCall?.[1].startOffset).toBe((count - 1) * 7);
});
