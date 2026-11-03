import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationHistory, historyChunkForRun } from "../src/components/ConversationHistory.tsx";
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

it("bounds placeholder nodes in long histories and restores details across chunk unmounts", async () => {
  const longRuns: RunView[] = Array.from({ length: 1000 }, (_, i) => ({ ...runs[0], runId: `long-${i}` }));
  const draw = (run: RunView) => createElement("details", {}, createElement("summary", {}, run.runId));
  const renderWith = (id: string) =>
    reactRoot.render(
      createElement(ConversationHistory, {
        runs: longRuns,
        root: roots,
        windowed: true,
        pinnedRunIds: new Set([id]),
        renderRun: draw,
      }),
    );
  await act(async () => renderWith("long-0"));
  expect(container.querySelectorAll("[data-history-chunk]")).toHaveLength(16);
  expect(container.querySelectorAll("[data-history-run]").length).toBeLessThan(160);
  const details = container.querySelector<HTMLDetailsElement>('[data-history-run="long-0"] details');
  if (!details) throw new Error("missing pinned run");
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  await act(async () => renderWith("long-300"));
  expect(container.querySelector('[data-history-run="long-0"]')).toBeNull();
  await act(async () => renderWith("long-0"));
  expect(container.querySelector<HTMLDetailsElement>('[data-history-run="long-0"] details')?.open).toBe(true);
});

it("keeps the same tail DOM when a new run is appended", async () => {
  const draw = (run: RunView) => createElement("details", {}, createElement("summary", {}, run.runId));
  const renderItems = (items: RunView[]) =>
    reactRoot.render(
      createElement(ConversationHistory, { runs: items, root: roots, windowed: false, renderRun: draw }),
    );
  await act(async () => renderItems(runs.slice(0, 1)));
  const original = row(0);
  const details = original.querySelector("details");
  if (!details) throw new Error("missing tail");
  details.open = true;
  await act(async () => renderItems(runs.slice(0, 2)));
  expect(row(0)).toBe(original);
  expect(row(0).querySelector("details")?.open).toBe(true);
});

it("retains details when prepending history moves a run into a different chunk", async () => {
  const items: RunView[] = Array.from({ length: 300 }, (_, index) => ({
    ...runs[0],
    runId: `chunk-${index}`,
  }));
  const draw = (run: RunView) => createElement("details", {}, createElement("summary", {}, run.runId));
  const renderItems = (values: RunView[]) =>
    reactRoot.render(
      createElement(ConversationHistory, {
        runs: values,
        root: roots,
        windowed: true,
        pinnedRunIds: new Set(["chunk-100"]),
        renderRun: draw,
      }),
    );
  await act(async () => renderItems(items));
  const details = container.querySelector<HTMLDetailsElement>('[data-history-run="chunk-100"] details');
  if (!details) throw new Error("missing pinned run");
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  await act(async () => renderItems([{ ...runs[0], runId: "prepend" }, ...items]));
  expect(container.querySelector<HTMLDetailsElement>('[data-history-run="chunk-100"] details')?.open).toBe(
    true,
  );
});

it("preserves selected and focused DOM when pages prepend and new turns append to chunked history", async () => {
  const items: RunView[] = Array.from({ length: 500 }, (_, index) => ({
    ...runs[0],
    runId: `stable-${index}`,
    userMessage: `Stable question ${index}`,
  }));
  const renderItems = (values: RunView[]) =>
    reactRoot.render(
      createElement(ConversationHistory, {
        runs: values,
        root: roots,
        windowed: true,
        pinnedRunIds: new Set(["stable-100"]),
        renderRun,
      }),
    );
  await act(async () => renderItems(items.slice(20, 400)));
  const button = container.querySelector<HTMLButtonElement>('[data-history-run="stable-100"] button');
  if (!button) throw new Error("missing selected message");
  const range = document.createRange();
  range.selectNodeContents(button);
  await act(async () => {
    button.focus();
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const selected = document.getSelection()?.toString();
  for (const values of [items.slice(10, 400), items.slice(0, 400), items]) {
    await act(async () => renderItems(values));
    expect(container.querySelector('[data-history-run="stable-100"] button')).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(document.getSelection()?.toString()).toBe(selected);
    expect(
      historyChunkForRun(
        scroll,
        values.findIndex((run) => run.runId === "stable-100"),
      )?.contains(button),
    ).toBe(true);
  }
  const leading = historyChunkForRun(scroll, 10);
  expect(leading?.dataset.historyStart).toBe("0");
  expect(leading?.dataset.historyEnd).toBe("20");
  expect(leading?.style.height).toBe(`${20 * 320}px`);
});

it("defers switching to chunk layout while history contains a selection", async () => {
  const items: RunView[] = Array.from({ length: 256 }, (_, index) => ({
    ...runs[0],
    runId: `threshold-${index}`,
  }));
  const renderItems = (values: RunView[]) =>
    reactRoot.render(
      createElement(ConversationHistory, { runs: values, root: roots, windowed: true, renderRun }),
    );
  await act(async () => renderItems(items.slice(0, 255)));
  const tail = container.querySelector<HTMLElement>('[data-history-run="threshold-254"] article');
  if (!tail) throw new Error("missing selected tail");
  const range = document.createRange();
  range.selectNodeContents(tail);
  await act(async () => {
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const selected = document.getSelection()?.toString();
  await act(async () => renderItems(items));
  expect(container.querySelectorAll("[data-history-chunk]")).toHaveLength(0);
  expect(document.getSelection()?.toString()).toBe(selected);
  await act(async () => {
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(container.querySelectorAll("[data-history-chunk]")).toHaveLength(4);
});

it("preserves a reading anchor when switching to chunk layout", async () => {
  const items: RunView[] = Array.from({ length: 256 }, (_, index) => ({
    ...runs[0],
    runId: `anchor-${index}`,
  }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const y =
      this === scroll
        ? 0
        : this.hasAttribute("data-history-run")
          ? container.querySelector("[data-history-chunk]")
            ? 120
            : 80
          : 0;
    return { x: 0, y, top: y, bottom: y + 420, left: 0, right: 600, height: 420, width: 600, toJSON() {} };
  });
  const draw = (values: RunView[]) =>
    reactRoot.render(
      createElement(ConversationHistory, { runs: values, root: roots, windowed: true, renderRun }),
    );
  await act(async () => draw(items.slice(0, 255)));
  scroll.scrollTop = 1000;
  await act(async () => draw(items));
  expect(scroll.scrollTop).toBe(1040);
});
