import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusComposer, useStore } from "../src/renderer/store.ts";
import type { SessionRecord } from "../src/shared/bridge.ts";

function element({
  hiddenTree = false,
  rendered = true,
  visibility = "visible",
  connected = true,
  disabled = false,
} = {}) {
  return {
    isConnected: connected,
    visibility,
    closest: vi.fn(() => (hiddenTree ? {} : null)),
    getClientRects: () => (rendered ? [{}] : []),
    matches: vi.fn(() => disabled),
    focus: vi.fn(),
  };
}

const frames: FrameRequestCallback[] = [];
let document: {
  visibilityState: string;
  activeElement: ReturnType<typeof element> | null;
  body: ReturnType<typeof element>;
  documentElement: ReturnType<typeof element>;
  querySelector: ReturnType<typeof vi.fn>;
  querySelectorAll: ReturnType<typeof vi.fn>;
};
let main: ReturnType<typeof element>;
let side: ReturnType<typeof element>;
const task = { id: "main", title: "Task", projectId: null, createdAt: 0, updatedAt: 0 } as SessionRecord;
const child = { ...task, id: "side", parentSessionId: task.id };
function frame() {
  for (const callback of frames.splice(0)) callback(0);
}

beforeEach(() => {
  frames.length = 0;
  main = element();
  side = element();
  const body = element();
  document = {
    visibilityState: "visible",
    activeElement: body,
    body,
    documentElement: element(),
    querySelector: vi.fn((selector: string) => (selector.includes("data-side-chat-session") ? side : main)),
    querySelectorAll: vi.fn(() => []),
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", (node: { visibility: string }) => node);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  useStore.setState({
    selected: task.id,
    sessions: new Map([
      [task.id, task],
      [child.id, child],
    ]),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("explicit focus targets the selected main task even when the side composer already has focus", () => {
  document.activeElement = side;
  focusComposer(task.id);
  frame();
  expect(main.focus).toHaveBeenCalledOnce();
  expect(side.focus).not.toHaveBeenCalled();
  expect(document.querySelector).toHaveBeenCalledExactlyOnceWith(
    "main .composer-container .mention-editor[contenteditable=true]",
  );
});

it("keeps the existing auxiliary-conversation helper behavior", () => {
  focusComposer(child.id);
  frame();
  expect(side.focus).toHaveBeenCalledOnce();
  expect(main.focus).not.toHaveBeenCalled();
});

describe("window restoration fallback", () => {
  it.each(["main composer", "side composer", "terminal textarea", "browser address", "ordinary button"])(
    "leaves the valid %s and its selection entirely untouched",
    (target) => {
      const active = target === "main composer" ? main : target === "side composer" ? side : element();
      document.activeElement = active;
      focusComposer(task.id, { onlyIfFocusLost: true });
      frame();
      expect(active.focus).not.toHaveBeenCalled();
      expect(main.focus).not.toHaveBeenCalled();
      expect(document.querySelector).not.toHaveBeenCalled();
    },
  );

  it.each([
    "body",
    "html",
    "missing",
    "removed",
    "disabled",
    "hidden tree",
    "no layout",
    "CSS hidden",
    "CSS collapse",
  ])("falls back only when the former target is invalid: %s", (target) => {
    document.activeElement =
      target === "body"
        ? document.body
        : target === "html"
          ? document.documentElement
          : target === "missing"
            ? null
            : element({
                connected: target !== "removed",
                disabled: target === "disabled",
                hiddenTree: target === "hidden tree",
                rendered: target !== "no layout",
                visibility:
                  target === "CSS hidden" ? "hidden" : target === "CSS collapse" ? "collapse" : "visible",
              });
    focusComposer(task.id, { onlyIfFocusLost: true });
    frame();
    expect(main.focus).toHaveBeenCalledOnce();
  });

  it("rechecks a newly focused target at dispatch instead of overriding it with a stale fallback", () => {
    focusComposer(task.id, { onlyIfFocusLost: true });
    document.activeElement = side;
    frame();
    expect(main.focus).not.toHaveBeenCalled();
    expect(side.focus).not.toHaveBeenCalled();
  });
});

it.each(["no selection", "selection changed", "task removed", "window hidden"])(
  "does not focus or create a task when %s",
  (condition) => {
    focusComposer(task.id);
    if (condition === "no selection") useStore.setState({ selected: undefined });
    if (condition === "selection changed") useStore.setState({ selected: "other" });
    if (condition === "task removed") useStore.setState({ sessions: new Map() });
    if (condition === "window hidden") document.visibilityState = "hidden";
    frame();
    expect(main.focus).not.toHaveBeenCalled();
    expect(document.querySelector).not.toHaveBeenCalled();
  },
);

it.each(["settings", "question", "menu", "listbox", "dialog", "recording"])(
  "does not cross a visible %s blocker during explicit focus or window restoration",
  (kind) => {
    document.querySelectorAll.mockImplementation((selector: string) =>
      selector.includes(
        {
          settings: ".settings-screen",
          question: '[role="dialog"]',
          menu: '[role="menu"]',
          listbox: '[role="listbox"]',
          dialog: '[role="alertdialog"]',
          recording: '[data-shortcut-recording="true"]',
        }[kind] ?? "",
      )
        ? [element()]
        : [],
    );
    focusComposer(task.id);
    focusComposer(task.id, { onlyIfFocusLost: true });
    frame();
    expect(main.focus).not.toHaveBeenCalled();
  },
);

it.each([{ hiddenTree: true }, { rendered: false }, { visibility: "hidden" }, { visibility: "collapse" }])(
  "ignores hidden retained blockers: %j",
  (options) => {
    document.querySelectorAll.mockReturnValue([element(options)]);
    focusComposer(task.id, { onlyIfFocusLost: true });
    frame();
    expect(main.focus).toHaveBeenCalledOnce();
  },
);

it.each([{ connected: false }, { hiddenTree: true }, { rendered: false }, { visibility: "hidden" }])(
  "does not focus an unavailable target editor: %j",
  (options) => {
    main = element(options);
    focusComposer(task.id);
    frame();
    expect(main.focus).not.toHaveBeenCalled();
  },
);
