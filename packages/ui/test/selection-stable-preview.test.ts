import type { RefObject } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSelectionStableValue } from "../src/components/use-selection-stable-value.ts";

const hooks = vi.hoisted(() => ({
  state: undefined as unknown,
  ref: { current: false },
  effect: undefined as undefined | (() => () => void),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: () => hooks.ref,
  useState: (initial: unknown) => {
    hooks.state ??= initial;
    return [
      hooks.state,
      (value: unknown) => {
        hooks.state = typeof value === "function" ? value(hooks.state) : value;
      },
    ];
  },
  useEffect: (effect: () => () => void) => {
    hooks.effect = effect;
  },
}));

let selected = false;
let intersects = true;
let listener: (() => void) | undefined;
const add = vi.fn((_type: string, callback: () => void) => {
  listener = callback;
});
const remove = vi.fn((_type: string, callback: () => void) => {
  if (listener === callback) listener = undefined;
});
const selection = {
  get isCollapsed() {
    return !selected;
  },
  rangeCount: 1,
  getRangeAt: () => ({ intersectsNode: () => intersects }),
};
const document = { addEventListener: add, removeEventListener: remove, getSelection: () => selection };
const root = { current: { ownerDocument: document } } as unknown as RefObject<HTMLElement | null>;
// biome-ignore lint/correctness/useHookAtTopLevel: Each call simulates one complete render with mocked hooks.
const display = (value: unknown, scope = "write:news.json") => useSelectionStableValue(value, scope, root);

beforeEach(() => {
  hooks.state = undefined;
  hooks.ref.current = false;
  hooks.effect = undefined;
  selected = false;
  intersects = true;
  listener = undefined;
  add.mockClear();
  remove.mockClear();
  vi.stubGlobal("document", document);
});
afterEach(() => vi.unstubAllGlobals());

it("displays incoming frames immediately when no text is selected", () => {
  expect(display("first")).toBe("first");
  expect(display("latest")).toBe("latest");
});

it("freezes text and tokens together even before selectionchange fires", () => {
  const initial = { text: "first", tokens: undefined };
  expect(display(initial)).toBe(initial);
  selected = true;
  const highlighted = { text: "first", tokens: [["first"]] };
  expect(display(highlighted)).toBe(initial);
  expect(display({ text: "latest", tokens: undefined })).toBe(initial);
  expect(display({ text: "latest", tokens: [["latest"]] })).toBe(initial);
});

it("replays the latest frame on clearing the range without another stream update", () => {
  display("first");
  const cleanup = hooks.effect?.();
  selected = true;
  expect(display("middle")).toBe("first");
  expect(display("final")).toBe("first");
  const frozen = hooks.state;
  selected = false;
  listener?.();
  expect(hooks.state).not.toBe(frozen);
  expect(display("final")).toBe("final");
  cleanup?.();
});

it("keeps completion or cancellation from replacing a selected tool preview", () => {
  const preparing = { status: "preparing", content: "selected" };
  display(preparing);
  selected = true;
  const completed = { status: "completed", fileChange: { patch: "final diff" } };
  expect(display(completed)).toBe(preparing);
  const cancelled = { status: "error", output: "Interrupted" };
  expect(display(cancelled)).toBe(preparing);
  selected = false;
  expect(display(cancelled)).toBe(cancelled);
});

it("does not freeze for a selection outside this container", () => {
  display("first");
  selected = true;
  intersects = false;
  expect(display("latest")).toBe("latest");
});

it("releases the snapshot when the selection moves into another container", () => {
  display("first");
  selected = true;
  expect(display("middle")).toBe("first");
  intersects = false;
  expect(display("latest")).toBe("latest");
});

it("resets the snapshot on a tool or file scope change even with a live range", () => {
  display("first");
  selected = true;
  expect(display("new file", "write:other.json")).toBe("new file");
  expect(display("new tool", "write2:other.json")).toBe("new tool");
});

it("keeps only the current visible snapshot while arbitrarily many frames arrive", () => {
  const initial = { content: "selected" };
  display(initial);
  selected = true;
  for (let index = 0; index < 1000; index++) expect(display({ content: `${index}` })).toBe(initial);
  expect(hooks.state).toEqual({ scopeKey: "write:news.json", value: initial });
  selected = false;
  expect(display("final")).toBe("final");
  expect(hooks.state).toEqual({ scopeKey: "write:news.json", value: "final" });
});

it("unsubscribes on unmount and does not leave a frozen listener behind", () => {
  display("first");
  const cleanup = hooks.effect?.();
  expect(add).toHaveBeenCalledWith("selectionchange", expect.any(Function));
  selected = true;
  expect(display("latest")).toBe("first");
  cleanup?.();
  expect(remove).toHaveBeenCalledWith("selectionchange", add.mock.calls[0][1]);
  expect(listener).toBeUndefined();
});

it("does not rerender unrelated previews for selection changes when nothing is deferred", () => {
  display("first");
  const cleanup = hooks.effect?.();
  const current = hooks.state;
  listener?.();
  expect(hooks.state).toBe(current);
  cleanup?.();
});
