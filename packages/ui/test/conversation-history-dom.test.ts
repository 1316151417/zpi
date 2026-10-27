import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationHistory } from "../src/components/ConversationHistory.tsx";
import type { RunView } from "../src/types.ts";

let container: HTMLDivElement, scroll: HTMLDivElement, reactRoot: Root;
let observe: (entries: { target: Element; isIntersecting: boolean }[]) => void;
let observationStarts = 0;
const resize = new Map<Element, () => void>();
const roots = { current: null as HTMLDivElement | null };
let height = 420,
  top = 0;
const runs: RunView[] = Array.from({ length: 200 }, (_, i) => ({
  runId: `run-${i}`,
  status: "completed",
  startedAt: 1,
  userMessage: `Question ${i}`,
  orderedBlocks: [],
  finalAnswerBlockIds: [],
}));
const renderRun = (run: RunView) =>
  createElement("article", { "data-run-id": run.runId }, createElement("button", {}, run.userMessage));

beforeEach(() => {
  observationStarts = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof observe) {
        observationStarts++;
        observe = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(privateCallback: () => void) {
        this.callback = privateCallback;
      }
      callback: () => void;
      observe(node: Element) {
        resize.set(node, this.callback);
      }
      disconnect() {}
    },
  );
  height = 420;
  top = 0;
  scroll = document.createElement("div");
  container = document.createElement("div");
  scroll.append(container);
  document.body.append(scroll);
  roots.current = scroll;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return {
      x: 0,
      y: this === scroll ? 0 : top,
      top: this === scroll ? 0 : top,
      height: this === scroll ? 600 : height,
      width: 600,
      left: 0,
      right: 600,
      bottom: this === scroll ? 600 : top + height,
      toJSON() {},
    };
  });
  reactRoot = createRoot(container);
});

it("observes history after an ancestor scroll ref is attached", async () => {
  const parent = { current: null as HTMLDivElement | null };
  await act(async () =>
    reactRoot.render(
      createElement(
        "div",
        { ref: parent },
        createElement(ConversationHistory, {
          runs,
          root: parent,
          windowed: true,
          renderRun,
        }),
      ),
    ),
  );
  expect(observationStarts).toBe(1);
  await intersect(10, true);
  expect(row(10).querySelector("article")).not.toBeNull();
});
afterEach(async () => {
  document.getSelection()?.removeAllRanges();
  await act(async () => reactRoot.unmount());
  scroll.remove();
  resize.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(
  windowed = true,
  initialRunId?: string,
  items = runs,
  pinnedRunIds?: ReadonlySet<string>,
) {
  await act(async () =>
    reactRoot.render(
      createElement(ConversationHistory, {
        runs: items,
        root: roots,
        windowed,
        initialRunId,
        pinnedRunIds,
        renderRun,
      }),
    ),
  );
}
const row = (id: number) => container.querySelector(`[data-history-run="run-${id}"]`) as HTMLElement;
async function intersect(id: number, visible: boolean) {
  await act(async () => observe([{ target: row(id), isIntersecting: visible }]));
}

it("mounts only the live tail and nearby history while retaining stable navigation placeholders", async () => {
  await render();
  expect(container.querySelectorAll("[data-history-run]")).toHaveLength(200);
  expect(container.querySelectorAll("article")).toHaveLength(4);
  expect(row(10).style.height).toBe("320px");
  await intersect(10, true);
  expect(row(10).querySelector("article")).not.toBeNull();
  await intersect(10, false);
  expect(row(10).querySelector("article")).toBeNull();
  expect(row(10).style.height).toBe("420px");
  expect(container.querySelectorAll("article")).toHaveLength(4);
});

it("updates placeholder heights without applying a second manual scroll correction", async () => {
  await render();
  scroll.scrollTop = 1000;
  top = -500;
  await intersect(10, true);
  height = 500;
  await act(async () => resize.get(row(10))?.());
  await intersect(10, false);
  expect(row(10).style.height).toBe("500px");
  expect(scroll.scrollTop).toBe(1000);
});

it("pins selection and focus until they leave an offscreen turn", async () => {
  await render();
  await intersect(10, true);
  const button = row(10).querySelector("button");
  if (!button) throw new Error("Missing mounted turn");
  await act(async () => button.focus());
  await intersect(10, false);
  expect(row(10).querySelector("article")).not.toBeNull();
  const range = document.createRange();
  range.selectNodeContents(button);
  await act(async () => {
    document.getSelection()?.addRange(range);
    button.blur();
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(row(10).querySelector("article")).not.toBeNull();
  await act(async () => {
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(row(10).querySelector("article")).toBeNull();
});

it("keeps the saved reading target and any running turn mounted on initial render", async () => {
  await render(true, "run-30", [{ ...runs[0], status: "running" }, ...runs.slice(1)]);
  expect(row(30).querySelector("article")).not.toBeNull();
  expect(row(0).querySelector("article")).not.toBeNull();
  expect(container.querySelectorAll("article")).toHaveLength(14);
});

it("releases an offscreen focused turn when focus is cleared", async () => {
  await render();
  await intersect(10, true);
  const button = row(10).querySelector("button");
  if (!button) throw new Error("Missing mounted turn");
  await act(async () => button.focus());
  await intersect(10, false);
  expect(row(10).querySelector("article")).not.toBeNull();
  await act(async () => button.blur());
  expect(row(10).querySelector("article")).toBeNull();
});

it("reuses measured heights when windowing begins", async () => {
  await render(false);
  expect(container.querySelectorAll("article")).toHaveLength(200);
  await render(true);
  // Existing content stays mounted until the first visibility sample after the transition.
  expect(container.querySelectorAll("article")).toHaveLength(200);
  await intersect(199, true);
  expect(container.querySelectorAll("article")).toHaveLength(4);
  expect(row(10).style.height).toBe("420px");
});

it("mounts a pinned search target while retaining the rest of the history placeholders", async () => {
  await render(true, undefined, runs, new Set(["run-10"]));
  expect(row(10).querySelector("article")).not.toBeNull();
  expect(container.querySelectorAll("article")).toHaveLength(5);
  await render();
  expect(row(10).querySelector("article")).toBeNull();
  expect(row(10).style.height).toBe("420px");
  expect(container.querySelectorAll("article")).toHaveLength(4);
});

it("restores details and nested scroll positions after virtual unmount", async () => {
  const draw = (run: RunView) =>
    createElement(
      "article",
      {},
      createElement(
        "details",
        {},
        createElement("summary", {}, run.userMessage),
        createElement("div", { "data-inner-scroll": true }, "Content"),
      ),
    );
  await act(async () =>
    reactRoot.render(
      createElement(ConversationHistory, { runs, root: roots, windowed: true, renderRun: draw }),
    ),
  );
  await intersect(10, true);
  const details = row(10).querySelector("details");
  const inner = row(10).querySelector<HTMLElement>("[data-inner-scroll]");
  if (!details || !inner) throw new Error("Missing retained UI");
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  inner.scrollLeft = 91;
  inner.dispatchEvent(new Event("scroll"));
  await intersect(10, false);
  await intersect(10, true);
  expect(row(10).querySelector("details")?.open).toBe(true);
  expect(row(10).querySelector<HTMLElement>("[data-inner-scroll]")?.scrollLeft).toBe(91);
});
