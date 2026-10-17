import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Conversation } from "zpi-ui";
import { emptySession } from "zpi-ui/projection";
import { QuickChat } from "../src/renderer/QuickChat.tsx";
import QuickChatConversation, {
  type QuickChatConversationProps,
} from "../src/renderer/QuickChatConversation.tsx";
import type { CombinedSelection, PublicSettings, Result } from "../src/shared/bridge.ts";
import { defaultCapabilities, defaultPreferences } from "../src/shared/config.ts";
import type { QuickChatBridge, QuickChatSnapshot } from "../src/shared/quick-chat.ts";
import { quickChatModels, quickChatSelectionIsValid } from "../src/shared/quick-chat-settings.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

const ok = (): Result<void> => ({ ok: true, value: undefined });
const settings: PublicSettings = {
  webSearch: {
    provider: "deepseek",
    enabled: false,
    hasApiKey: false,
    apiKeyLength: 0,
    credentialsPersisted: false,
    credentialsLocked: false,
  },
  capabilities: defaultCapabilities,
  interface: { ...defaultPreferences, theme: "dark", fontSize: 15 },
  shortcuts: defaultShortcuts("darwin"),
  lastSelection: null,
  quickChat: { defaultSelection: null },
  credentialsPersisted: false,
  disabledSkillPaths: [],
  providers: [
    {
      id: "test",
      name: "Test provider",
      baseUrl: "https://example.invalid",
      hasApiKey: true,
      models: [
        { id: "first", name: "First model", reasoning: false },
        { id: "second", name: "Second model", reasoning: false },
        { id: "disabled", name: "Disabled model", reasoning: false, enabled: false },
      ],
    },
    {
      id: "disabled",
      name: "Disabled provider",
      baseUrl: "https://example.invalid",
      hasApiKey: true,
      enabled: false,
      models: [{ id: "hidden", reasoning: false }],
    },
  ],
};

let root: Root;
let container: HTMLDivElement;
let snapshot: QuickChatSnapshot;
let bridge: QuickChatBridge;
let listeners: Set<(snapshot: QuickChatSnapshot) => void>;
let presentationListeners: Set<(token: number) => void>;
let storageWrite: ReturnType<typeof vi.spyOn>;
let conversationLoader: ReturnType<typeof vi.fn<() => Promise<{ default: typeof QuickChatConversation }>>>;

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element as T;
}
const input = () => query<HTMLTextAreaElement>("textarea");
const button = (label: string) => query<HTMLButtonElement>(`button[aria-label="${label}"]`);
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};
const type = async (text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const key = async (target: EventTarget, value: string, options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
};
const composition = async (type: "compositionstart" | "compositionend") => {
  await act(async () => {
    input().dispatchEvent(new CompositionEvent(type, { bubbles: true, data: "中文" }));
  });
};
const state = () => query<HTMLElement>("[data-testid='quick-chat']").dataset.state;
const mount = async () => {
  await act(async () => root.render(createElement(QuickChat, { conversationLoader })));
};
const emit = (patch: Partial<QuickChatSnapshot> = {}) => {
  snapshot = { ...snapshot, revision: snapshot.revision + 1, ...patch };
  for (const listener of listeners) listener(snapshot);
};
const push = async (patch: Partial<QuickChatSnapshot> = {}) => {
  await act(async () => emit(patch));
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const run = (status: "running" | "completed") => ({
  runId: "run-1",
  status,
  userMessage: "hello",
  orderedBlocks: [],
  finalAnswerBlockIds: [],
  startedAt: 1,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", Object.assign(Object.create(CSS), { highlights: new Map() }));
  snapshot = {
    revision: 1,
    session: emptySession("quick-session"),
    settings,
    selection: { provider: "test", modelId: "first", reasoning: "none" },
    cwd: "/private/home/Documents/ZPI",
  };
  conversationLoader = vi.fn(async () => ({ default: QuickChatConversation }));
  listeners = new Set();
  presentationListeners = new Set();
  bridge = {
    getSnapshot: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    send: vi.fn(async () => ok()),
    stop: vi.fn(async () => ok()),
    reset: vi.fn(async () => ok()),
    hide: vi.fn(async () => ok()),
    setComposerHeight: vi.fn(async () => ok()),
    rendererReady: vi.fn(async () => ok()),
    reportPresentation: vi.fn(async () => ok()),
    onPresentation: vi.fn((listener) => {
      presentationListeners.add(listener);
      return () => {
        presentationListeners.delete(listener);
      };
    }),
    copyText: vi.fn(async () => ok()),
    openExternal: vi.fn(async () => ok()),
    readWebSourceIcon: vi.fn(async () => ({ ok: true as const, value: {} })),
    onSnapshot: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  Object.defineProperty(window, "zpiQuickChat", { configurable: true, value: bridge });
  Object.defineProperty(window, "zpi", {
    configurable: true,
    get() {
      throw new Error("Quick chat must not access the main-window bridge");
    },
  });
  localStorage.clear();
  storageWrite = vi.spyOn(Storage.prototype, "setItem");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    await vi.dynamicImportSettled();
    root.unmount();
  });
  expect(listeners.size).toBe(0);
  expect(presentationListeners.size).toBe(0);
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("opens as a slim input with the task send control, theme, and isolated bridge", async () => {
  await mount();
  expect(document.title).toBe("快速对话 · ZPI");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.dataset.quickChat).toBe("true");
  expect(document.documentElement.style.getPropertyValue("--ui-font-size")).toBe("15px");
  expect(state()).toBe("compact");
  expect(input().getAttribute("rows")).toBe("1");
  expect(input().disabled).toBe(false);
  expect(container.querySelector("header, .conversation, .composer-footer, .quick-chat-title")).toBeNull();
  expect(container.querySelector(".sidebar, .settings-screen, .composer-plus, .model-trigger")).toBeNull();
  expect(container.textContent).toBe("");
  expect(button("发送").className).toBe("send");
  expect(button("发送").disabled).toBe(true);
  expect(button("发送").querySelector("svg")?.getAttribute("width")).toBe("16");
  expect(conversationLoader).not.toHaveBeenCalled();
  expect("setSelection" in bridge).toBe(false);
  expect(storageWrite).not.toHaveBeenCalled();
});

// happy-dom runs real React state/effects/events, but not text layout or a compositor.
// Only the browser's measured geometry and animation clock are supplied by these tests.
function measureInput(height: () => number, available?: () => number) {
  Object.defineProperty(input(), "scrollHeight", { configurable: true, get: height });
  if (available) Object.defineProperty(input(), "clientHeight", { configurable: true, get: available });
}

function animationClock() {
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return async () => {
    const current = [...frames];
    frames.clear();
    await act(async () => {
      for (const [, callback] of current) callback(performance.now());
    });
  };
}

test("grows, caps, and shrinks compact input from native textarea measurements without duplicate IPC", async () => {
  await mount();
  expect(bridge.setComposerHeight).toHaveBeenCalledExactlyOnceWith("quick-session", 44);
  measureInput(() => input().value.split("\n").length * 24);
  await type("first\nsecond");
  expect(input().style.height).toBe("48px");
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 64);
  await type("first\nsecond edited");
  await push();
  await push();
  expect(bridge.setComposerHeight).toHaveBeenCalledTimes(2);
  await type(Array.from({ length: 7 }, (_, index) => `line ${index}`).join("\n"));
  expect(input().style.height).toBe("168px");
  expect(input().style.overflowY).toBe("hidden");
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 184);
  await type(Array.from({ length: 15 }, (_, index) => `line ${index}`).join("\n"));
  expect(input().style.height).toBe("168px");
  expect(input().style.overflowY).toBe("auto");
  expect(bridge.setComposerHeight).toHaveBeenCalledTimes(3);
  await type("");
  expect(input().style.height).toBe("24px");
  expect(input().style.overflowY).toBe("hidden");
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 44);
});

test("measures early multiline drafts and reports them as soon as the first session arrives", async () => {
  const request = deferred<Result<QuickChatSnapshot>>();
  vi.mocked(bridge.getSnapshot).mockReturnValue(request.promise);
  await mount();
  measureInput(() => input().value.split("\n").length * 24);
  await type("draft\nbefore\nsnapshot");
  expect(input().style.height).toBe("72px");
  expect(bridge.setComposerHeight).not.toHaveBeenCalled();
  expect(bridge.send).not.toHaveBeenCalled();
  await act(async () => request.resolve({ ok: true, value: snapshot }));
  expect(input().value).toBe("draft\nbefore\nsnapshot");
  expect(bridge.setComposerHeight).toHaveBeenCalledExactlyOnceWith("quick-session", 88);
});

test("remeasures wrapped text after width and font changes while ignoring token-only snapshots", async () => {
  const frame = animationClock();
  const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      disconnect() {}
    },
  );
  const fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  try {
    await mount();
    let measured = 24;
    measureInput(() => measured);
    await type("a long pasted paragraph whose wrapping depends on the input width");
    expect(bridge.setComposerHeight).toHaveBeenCalledTimes(1);
    measured = 96;
    const observer = observers.findLast((candidate) => candidate.targets.includes(input()));
    expect(observer).toBeDefined();
    const resized = (width: number) => {
      observer?.callback(
        [
          {
            target: input(),
            contentRect: new DOMRectReadOnly(0, 0, width, 24),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          },
        ],
        {} as ResizeObserver,
      );
    };
    await act(async () => resized(220));
    await frame();
    expect(input().style.height).toBe("96px");
    expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 112);
    await act(async () => resized(220));
    await frame();
    await push();
    expect(bridge.setComposerHeight).toHaveBeenCalledTimes(2);
    measured = 120;
    await push({ settings: { ...settings, interface: { ...settings.interface, fontSize: 18 } } });
    expect(input().style.height).toBe("120px");
    expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 136);
    measured = 144;
    await act(async () => fonts.dispatchEvent(new Event("loadingdone")));
    await frame();
    expect(input().style.height).toBe("144px");
    expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 160);
  } finally {
    Reflect.deleteProperty(document, "fonts");
  }
});

test("retries a failed current height request without allowing an old failure to invalidate the new height", async () => {
  const frame = animationClock();
  const old = deferred<Result<void>>();
  vi.mocked(bridge.setComposerHeight).mockReturnValueOnce(old.promise);
  await mount();
  measureInput(() => input().value.split("\n").length * 24);
  await type("one\ntwo");
  await act(async () => old.reject(new Error("old resize failure")));
  await act(async () => window.dispatchEvent(new Event("resize")));
  await frame();
  expect(bridge.setComposerHeight).toHaveBeenCalledTimes(2);
  vi.mocked(bridge.setComposerHeight).mockResolvedValueOnce({
    ok: false,
    error: { code: "busy", message: "not ready" },
  });
  await type("one\ntwo\nthree");
  await act(async () => window.dispatchEvent(new Event("focus")));
  await frame();
  expect(bridge.setComposerHeight).toHaveBeenCalledTimes(4);
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 88);
  expect(input().value).toBe("one\ntwo\nthree");
});

test("keeps overflowing text scrollable when the native display clamps the compact window", async () => {
  const frame = animationClock();
  await mount();
  let available = 64;
  measureInput(
    () => 120,
    () => available,
  );
  await type("multiline text on a short display");
  expect(input().style.height).toBe("120px");
  expect(input().style.overflowY).toBe("auto");
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 136);
  available = 120;
  await act(async () => window.dispatchEvent(new Event("resize")));
  await frame();
  expect(input().style.overflowY).toBe("hidden");
  expect(bridge.setComposerHeight).toHaveBeenCalledTimes(2);
});

test("preserves a tall hidden draft and resets height only when the accepted session changes", async () => {
  const frame = animationClock();
  await mount();
  measureInput(() => input().value.split("\n").length * 24);
  await type("one\ntwo\nthree");
  await key(input(), "Escape");
  await act(async () => window.dispatchEvent(new Event("focus")));
  await frame();
  expect(input().value).toBe("one\ntwo\nthree");
  expect(input().style.height).toBe("72px");
  expect(bridge.setComposerHeight).toHaveBeenCalledTimes(2);
  await push({ session: emptySession("replacement-session") });
  expect(input().value).toBe("");
  expect(input().style.height).toBe("24px");
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("replacement-session", 44);
});

test("grows expanded input to 160px with internal scrolling without resizing the popup for tokens", async () => {
  await mount();
  await push({ session: { ...snapshot.session, runs: [run("running")] } });
  vi.mocked(bridge.setComposerHeight).mockClear();
  measureInput(() => input().value.split("\n").length * 24);
  await type("one\ntwo\nthree");
  expect(input().style.height).toBe("72px");
  expect(input().style.overflowY).toBe("hidden");
  await type(Array.from({ length: 12 }, () => "next draft").join("\n"));
  expect(input().style.height).toBe("160px");
  expect(input().style.overflowY).toBe("auto");
  await push({ session: { ...snapshot.session, runs: [run("completed")] } });
  expect(input().style.height).toBe("160px");
  expect(bridge.setComposerHeight).not.toHaveBeenCalled();
  await type("");
  expect(input().style.height).toBe("24px");
  expect(input().style.overflowY).toBe("hidden");
});

test("acknowledges only the current session after two frame opportunities and keeps early typing usable", async () => {
  const frame = animationClock();
  await mount();
  await type("before native presentation");
  expect(input().disabled).toBe(false);
  expect(bridge.rendererReady).not.toHaveBeenCalled();
  await frame();
  expect(bridge.rendererReady).not.toHaveBeenCalled();
  await push({ session: emptySession("fresh-session") });
  expect(input().value).toBe("");
  await frame();
  expect(bridge.rendererReady).not.toHaveBeenCalled();
  await frame();
  expect(bridge.rendererReady).toHaveBeenCalledExactlyOnceWith("fresh-session");
  await push();
  await frame();
  await frame();
  expect(bridge.rendererReady).toHaveBeenCalledOnce();
});

test("reports diagnostic input readiness, actual focus and double-frame opportunity for the latest token", async () => {
  const frame = animationClock();
  await mount();
  expect(bridge.reportPresentation).not.toHaveBeenCalled();
  await act(async () => {
    for (const listener of presentationListeners) listener(1);
  });
  expect(bridge.reportPresentation).toHaveBeenCalledWith(1, "renderer-ready");
  expect(bridge.reportPresentation).not.toHaveBeenCalledWith(1, "renderer-frame");
  await frame();
  expect(bridge.reportPresentation).toHaveBeenCalledWith(1, "renderer-focus");
  await act(async () => {
    for (const listener of presentationListeners) listener(2);
  });
  expect(bridge.reportPresentation).toHaveBeenCalledWith(2, "renderer-ready");
  expect(bridge.reportPresentation).toHaveBeenCalledWith(2, "renderer-focus");
  await frame();
  expect(bridge.reportPresentation).not.toHaveBeenCalledWith(1, "renderer-frame");
  expect(bridge.reportPresentation).not.toHaveBeenCalledWith(2, "renderer-frame");
  await frame();
  expect(bridge.reportPresentation).toHaveBeenCalledWith(2, "renderer-frame");
  await act(async () => {
    input().blur();
    input().focus();
  });
  expect(
    vi
      .mocked(bridge.reportPresentation)
      .mock.calls.filter(([token, stage]) => token === 2 && stage === "renderer-focus"),
  ).toHaveLength(1);
});

test("cancels pending session and diagnostic frame acknowledgements when the renderer unmounts", async () => {
  const frame = animationClock();
  await mount();
  await act(async () => {
    for (const listener of presentationListeners) listener(1);
  });
  await frame();
  await act(async () => root.render(null));
  vi.mocked(bridge.reportPresentation).mockClear();
  await frame();
  expect(bridge.rendererReady).not.toHaveBeenCalled();
  expect(bridge.reportPresentation).not.toHaveBeenCalled();
  expect(presentationListeners.size).toBe(0);
});

test("uses quick-only compact conversation spacing and circular controls without changing task defaults", async () => {
  const style = document.createElement("style");
  style.textContent = [
    readFileSync(new URL("../../ui/src/tokens.css", import.meta.url), "utf8"),
    readFileSync(new URL("../../ui/src/styles.css", import.meta.url), "utf8"),
    readFileSync(new URL("../src/renderer/quick-chat.css", import.meta.url), "utf8"),
  ].join("\n");
  document.head.append(style);
  try {
    await mount();
    expect(getComputedStyle(button("发送")).borderRadius).toBe("50%");
    expect(getComputedStyle(button("发送")).width).toBe("28px");
    expect(getComputedStyle(button("发送")).height).toBe("28px");
    await push({
      session: { ...snapshot.session, runs: [run("completed"), { ...run("completed"), runId: "run-2" }] },
    });
    const runs = [...container.querySelectorAll<HTMLElement>(".run-group")];
    expect(runs).toHaveLength(2);
    expect(getComputedStyle(runs[0]).paddingTop).toBe("8px");
    expect(getComputedStyle(runs[1]).paddingTop).toBe("12px");
    expect(getComputedStyle(runs[0]).paddingBottom).toBe("16px");
    expect(getComputedStyle(query(".conversation")).overflowY).toBe("auto");
    expect(getComputedStyle(button("发送")).borderRadius).toBe("50%");
    await act(async () =>
      root.render(
        createElement(Conversation, {
          view: { ...snapshot.session, runs: [run("completed")] },
          persistReading: false,
          onLink() {},
        }),
      ),
    );
    const taskRun = query<HTMLElement>(".run-group");
    expect(getComputedStyle(taskRun).paddingTop).toBe("56px");
    expect(getComputedStyle(taskRun).paddingBottom).toBe("20px");
    const taskSend = document.createElement("button");
    taskSend.className = "send";
    container.append(taskSend);
    expect(getComputedStyle(taskSend).borderRadius).toBe("8px");
  } finally {
    style.remove();
  }
});

test("keeps a newer pushed conversation when the initial request resolves late", async () => {
  const request = deferred<Result<QuickChatSnapshot>>();
  const old = snapshot;
  vi.mocked(bridge.getSnapshot).mockReturnValue(request.promise);
  await mount();
  await push({ session: { ...snapshot.session, runs: [run("completed")] } });
  await act(async () => request.resolve({ ok: true, value: old }));
  expect(state()).toBe("expanded");
  expect(container.textContent).toContain("hello");
});

test("expands only when the host accepts the first message into the conversation", async () => {
  const request = deferred<Result<void>>();
  vi.mocked(bridge.send).mockReturnValue(request.promise);
  await mount();
  await type("first question");
  await key(input(), "Enter");
  expect(state()).toBe("compact");
  expect(input().value).toBe("first question");
  await push({ session: { ...snapshot.session, runs: [run("running")] } });
  await act(async () => request.resolve(ok()));
  expect(state()).toBe("expanded");
  expect(input().value).toBe("");
  expect(button("新对话")).toBeDefined();
  expect(container.querySelector(".quick-chat-header")?.querySelectorAll("button")).toHaveLength(1);
  expect(container.querySelector('button[aria-label="隐藏"]')).toBeNull();
  expect(button("停止")).toBeDefined();
  expect(container.querySelector('button[aria-label="发送"], .model-trigger, .composer-footer')).toBeNull();
  expect("setSelection" in bridge).toBe(false);
});

test("sends once, preserves newer edits, and never writes input history", async () => {
  const request = deferred<Result<void>>();
  vi.mocked(bridge.send).mockReturnValue(request.promise);
  await mount();
  await type("first question");
  await key(input(), "Enter");
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledExactlyOnceWith("first question");
  await type("next question");
  await act(async () => request.resolve(ok()));
  expect(input().value).toBe("next question");
  expect(storageWrite).not.toHaveBeenCalled();
  vi.mocked(bridge.send).mockResolvedValue(ok());
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenLastCalledWith("next question");
  expect(input().value).toBe("");
});

test("retains a failed send in compact mode and permits an Enter retry", async () => {
  vi.mocked(bridge.send).mockResolvedValue({ ok: false, error: { code: "provider", message: "连接失败" } });
  await mount();
  await type("keep this question");
  await key(input(), "Enter");
  expect(input().value).toBe("keep this question");
  expect(state()).toBe("compact");
  expect(query('[role="alert"]').textContent).toContain("连接失败");
  vi.mocked(bridge.send).mockImplementation(async () => {
    emit({ session: { ...snapshot.session, runs: [run("running")] } });
    return ok();
  });
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledTimes(2);
  expect(input().value).toBe("");
  expect(state()).toBe("expanded");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test.each<[string, KeyboardEventInit]>([
  ["IME key", { isComposing: true }],
  ["IME compatibility key", { keyCode: 229 }],
  ["Shift+Enter", { shiftKey: true }],
  ["Ctrl+Enter", { ctrlKey: true }],
  ["Meta+Enter", { metaKey: true }],
  ["Alt+Enter", { altKey: true }],
  ["held Enter", { repeat: true }],
])("does not send for %s", async (_label, options) => {
  await mount();
  await type("中文输入");
  const event = await key(input(), "Enter", options);
  expect(bridge.send).not.toHaveBeenCalled();
  if (!options.repeat) expect(event.defaultPrevented).toBe(false);
  expect(input().value).toBe("中文输入");
});

test("respects composition events even when the key lacks an IME flag", async () => {
  await mount();
  await type("中文输入");
  await composition("compositionstart");
  await key(input(), "Enter");
  await key(input(), "Escape");
  expect(bridge.send).not.toHaveBeenCalled();
  expect(bridge.hide).not.toHaveBeenCalled();
  await composition("compositionend");
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledExactlyOnceWith("中文输入");
});

test("leaves Shift+Enter available for multiline input and submits the whole draft", async () => {
  await mount();
  await type("first line");
  const event = await key(input(), "Enter", { shiftKey: true });
  expect(event.defaultPrevented).toBe(false);
  // happy-dom has no browser editing default action; apply the resulting native input event.
  await type("first line\nsecond line");
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledExactlyOnceWith("first line\nsecond line");
  expect(input().value).toBe("");
});

test("does not submit an empty or whitespace-only draft", async () => {
  await mount();
  await key(input(), "Enter");
  await type(" \n ");
  await key(input(), "Enter");
  expect(bridge.send).not.toHaveBeenCalled();
  expect(state()).toBe("compact");
});

test("stops running output without losing the next draft or persisting reading positions", async () => {
  const request = deferred<Result<void>>();
  vi.mocked(bridge.stop).mockReturnValue(request.promise);
  await mount();
  await push({ session: { ...snapshot.session, runs: [run("running")] } });
  await type("next question");
  await key(input(), "Enter");
  expect(bridge.send).not.toHaveBeenCalled();
  await click(button("停止"));
  await click(button("停止"));
  expect(bridge.stop).toHaveBeenCalledOnce();
  expect(input().value).toBe("next question");
  await push({ session: { ...snapshot.session, runs: [run("completed")] } });
  await act(async () => request.resolve(ok()));
  expect(container.querySelector('button[aria-label="停止"]')).toBeNull();
  expect(button("发送").disabled).toBe(false);
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledExactlyOnceWith("next question");
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storageWrite).not.toHaveBeenCalled();
});

test("hides and reopens without discarding the expanded conversation or draft", async () => {
  await mount();
  await push({ session: { ...snapshot.session, runs: [run("completed")] } });
  const sessionId = snapshot.session.sessionId;
  await type("temporary draft");
  await key(input(), "Escape", { isComposing: true });
  await key(input(), "Escape", { keyCode: 229 });
  await key(input(), "Escape", { repeat: true });
  expect(bridge.hide).not.toHaveBeenCalled();
  await key(input(), "Escape");
  expect(bridge.hide).toHaveBeenCalledOnce();
  expect(input().value).toBe("temporary draft");
  await act(async () => {
    input().blur();
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(document.activeElement).toBe(input());
  expect(state()).toBe("expanded");
  expect(snapshot.session.sessionId).toBe(sessionId);
  expect(container.textContent).toContain("hello");
  expect(input().value).toBe("temporary draft");
  expect(bridge.reset).not.toHaveBeenCalled();
  expect(storageWrite).not.toHaveBeenCalled();
});

test("retains history on a failed reset, then returns to input-only after a successful reset", async () => {
  await mount();
  await push({ session: { ...snapshot.session, runs: [run("completed")] } });
  await type("temporary draft");
  vi.mocked(bridge.reset).mockResolvedValue({ ok: false, error: { code: "busy", message: "请重试" } });
  await click(button("新对话"));
  expect(state()).toBe("expanded");
  expect(container.textContent).toContain("hello");
  expect(input().value).toBe("temporary draft");
  vi.mocked(bridge.reset).mockImplementation(async () => {
    emit({ session: emptySession("next-quick-session") });
    return ok();
  });
  await click(button("新对话"));
  expect(state()).toBe("compact");
  expect(input().value).toBe("");
  expect(container.textContent).toBe("");
  expect(container.querySelector("header, .conversation")).toBeNull();
  expect(button("发送").disabled).toBe(true);
  expect("setSelection" in bridge).toBe(false);
});

test.each<{ label: string; selection: CombinedSelection | null }>([
  { label: "missing selection", selection: null },
  { label: "missing provider", selection: { provider: "missing", modelId: "first", reasoning: "none" } },
  { label: "disabled provider", selection: { provider: "disabled", modelId: "hidden", reasoning: "none" } },
  { label: "missing model", selection: { provider: "test", modelId: "missing", reasoning: "none" } },
  { label: "disabled model", selection: { provider: "test", modelId: "disabled", reasoning: "none" } },
  { label: "invalid reasoning", selection: { provider: "test", modelId: "first", reasoning: "high" } },
])(
  "directs host-rejected $label to settings without silently selecting another model",
  async ({ selection }) => {
    // The host validates these selections before publishing a snapshot.
    snapshot = {
      ...snapshot,
      selection: selection && quickChatSelectionIsValid(settings.providers, selection) ? selection : null,
    };
    await mount();
    await type("question");
    await key(input(), "Enter");
    expect(bridge.send).not.toHaveBeenCalled();
    expect("setSelection" in bridge).toBe(false);
    expect(input().value).toBe("question");
    expect(container.textContent).toContain("默认模型不可用");
    expect(container.textContent).toContain("设置 → 快速对话");
    expect(state()).toBe("compact");
    expect(input().getAttribute("aria-describedby")).toBe("quick-chat-configuration");
  },
);

test("uses a valid selection restored by settings without showing a floating model picker", async () => {
  snapshot = { ...snapshot, selection: null };
  await mount();
  await type("ready question");
  await push({ selection: { provider: "test", modelId: "second", reasoning: "none" } });
  expect(container.querySelector(".quick-chat-configuration, .model-trigger")).toBeNull();
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledExactlyOnceWith("ready question");
  expect("setSelection" in bridge).toBe(false);
});

test("validates reasoning against the provider API rather than an implicit completion API", async () => {
  snapshot = {
    ...snapshot,
    settings: {
      ...settings,
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          baseUrl: "https://example.invalid",
          api: "anthropic-messages",
          hasApiKey: true,
          models: [{ id: "reasoning", reasoning: true, compat: { supportsReasoningEffort: false } }],
        },
      ],
    },
    selection: { provider: "anthropic", modelId: "reasoning", reasoning: "high" },
  };
  await mount();
  expect(container.querySelector(".quick-chat-configuration")).toBeNull();
  await type("reason using this provider");
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledExactlyOnceWith("reason using this provider");
});

test("sends with a valid default reasoning level omitted from deduplicated display choices", async () => {
  snapshot = {
    ...snapshot,
    settings: {
      ...settings,
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          preset: "deepseek",
          api: "openai-completions",
          baseUrl: "https://example.invalid",
          hasApiKey: true,
          models: [
            {
              id: "reasoning",
              reasoning: true,
              defaultThinkingLevel: "medium",
              compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true },
              thinkingLevelMap: { medium: "high", high: "high" },
            },
          ],
        },
      ],
    },
    selection: { provider: "deepseek", modelId: "reasoning", reasoning: "medium" },
  };
  expect(quickChatModels(snapshot.settings.providers)[0]?.presets).not.toContain("medium");
  await mount();
  expect(container.querySelector(".quick-chat-configuration")).toBeNull();
  await type("use the saved default reasoning");
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledExactlyOnceWith("use the saved default reasoning");
});

test("retries a failed initial load without retaining an obsolete subscription", async () => {
  vi.mocked(bridge.getSnapshot).mockResolvedValueOnce({
    ok: false,
    error: { code: "storage", message: "暂时无法加载" },
  });
  await mount();
  expect(input().disabled).toBe(false);
  expect(button("发送").disabled).toBe(true);
  expect(state()).toBe("compact");
  const retry = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === "重新加载",
  );
  expect(retry).toBeDefined();
  await click(retry as HTMLButtonElement);
  expect(input().disabled).toBe(false);
  expect(listeners.size).toBe(1);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("preserves the main conversation's reading bookmarks by default", async () => {
  await act(async () => {
    root.render(
      createElement(Conversation, {
        view: { ...snapshot.session, runs: [run("completed")] },
        onLink() {},
      }),
    );
  });
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storageWrite).toHaveBeenCalledWith("zpi.reading.quick-session", expect.any(String));
});

test("accepts an early draft while waiting for the first snapshot without sending a default", async () => {
  const request = deferred<Result<QuickChatSnapshot>>();
  vi.mocked(bridge.getSnapshot).mockReturnValue(request.promise);
  await mount();
  expect(input().disabled).toBe(false);
  expect(input().placeholder).toBe("输入消息…");
  await type("typed before the host is ready");
  await key(input(), "Enter");
  await click(button("发送"));
  expect(bridge.send).not.toHaveBeenCalled();
  expect(button("发送").disabled).toBe(true);
  expect(conversationLoader).not.toHaveBeenCalled();
  await act(async () => request.resolve({ ok: true, value: snapshot }));
  expect(input().value).toBe("typed before the host is ready");
  expect(button("发送").disabled).toBe(false);
  await click(button("发送"));
  expect(bridge.send).toHaveBeenCalledExactlyOnceWith("typed before the host is ready");
  expect(input().value).toBe("");
});

test("keeps an early draft through a failed snapshot and successful reload", async () => {
  const request = deferred<Result<QuickChatSnapshot>>();
  vi.mocked(bridge.getSnapshot).mockReturnValueOnce(request.promise);
  await mount();
  await type("do not discard this draft");
  await act(async () => request.reject(new Error("暂时无法加载")));
  expect(input().disabled).toBe(false);
  expect(input().value).toBe("do not discard this draft");
  expect(query('[role="alert"]').getAttribute("title")).toBe("暂时无法加载");
  await click(query<HTMLButtonElement>(".quick-chat-retry"));
  expect(input().value).toBe("do not discard this draft");
  expect(button("发送").disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(listeners.size).toBe(1);
  expect(conversationLoader).not.toHaveBeenCalled();
});

test("ignores an obsolete load failure after accepting a newer snapshot", async () => {
  const request = deferred<Result<QuickChatSnapshot>>();
  vi.mocked(bridge.getSnapshot).mockReturnValue(request.promise);
  await mount();
  await type("still ready");
  await push();
  await act(async () => request.reject(new Error("obsolete load failure")));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(input().value).toBe("still ready");
  expect(button("发送").disabled).toBe(false);
});

test("loads rich output only after the first run and shows the latest snapshot when loading finishes", async () => {
  const request = deferred<{ default: typeof QuickChatConversation }>();
  conversationLoader.mockReturnValue(request.promise);
  await mount();
  expect(conversationLoader).not.toHaveBeenCalled();
  await push({ session: { ...snapshot.session, runs: [run("running")] } });
  expect(conversationLoader).toHaveBeenCalledOnce();
  expect(query('[role="status"]').textContent).toBe("正在加载对话…");
  expect(button("停止").className).toBe("send stop");
  expect(button("停止").querySelector("svg")?.getAttribute("width")).toBe("16");
  await type("next draft while output loads");
  await push({
    session: { ...snapshot.session, runs: [{ ...run("completed"), userMessage: "newest host output" }] },
  });
  await act(async () => request.resolve({ default: QuickChatConversation }));
  expect(container.querySelector(".quick-chat-conversation-placeholder")).toBeNull();
  expect(container.textContent).toContain("newest host output");
  expect(input().value).toBe("next draft while output loads");
  expect(conversationLoader).toHaveBeenCalledOnce();
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storageWrite).not.toHaveBeenCalled();
});

test("does not rerender loaded history for draft edits but renders new session snapshots", async () => {
  const renders = vi.fn<(props: QuickChatConversationProps) => void>();
  conversationLoader.mockResolvedValue({
    default: (props) => {
      renders(props);
      return createElement(QuickChatConversation, props);
    },
  });
  await mount();
  await push({ session: { ...snapshot.session, runs: [run("completed")] } });
  expect(container.textContent).toContain("hello");
  expect(renders).toHaveBeenCalledOnce();
  const onError = renders.mock.calls[0][0].onError;
  const history = query(".conversation");

  await type("next");
  await type("next question");
  await type("");
  expect(renders).toHaveBeenCalledOnce();
  expect(query(".conversation")).toBe(history);
  expect(conversationLoader).toHaveBeenCalledOnce();

  await push({
    session: { ...snapshot.session, runs: [{ ...run("completed"), userMessage: "updated history" }] },
  });
  expect(renders).toHaveBeenCalledTimes(2);
  expect(renders.mock.calls[1][0].onError).toBe(onError);
  expect(container.textContent).toContain("updated history");
  expect(container.textContent).not.toContain("hello");
  expect(conversationLoader).toHaveBeenCalledOnce();
});

test("uses a replacement loader and ignores the obsolete loader's late completion", async () => {
  const old = deferred<{ default: typeof QuickChatConversation }>();
  const current = deferred<{ default: typeof QuickChatConversation }>();
  conversationLoader.mockReturnValue(old.promise);
  await mount();
  await push({ session: { ...snapshot.session, runs: [run("completed")] } });
  const oldLoader = conversationLoader;
  conversationLoader = vi.fn(() => current.promise);
  await mount();
  expect(conversationLoader).toHaveBeenCalledOnce();
  await type("draft while the loader changes");
  await act(async () => old.resolve({ default: QuickChatConversation }));
  expect(container.querySelector(".conversation")).toBeNull();
  expect(query('[role="status"]').textContent).toBe("正在加载对话…");
  await act(async () => current.resolve({ default: QuickChatConversation }));
  expect(container.textContent).toContain("hello");
  expect(input().value).toBe("draft while the loader changes");
  expect(oldLoader).toHaveBeenCalledOnce();
  expect(conversationLoader).toHaveBeenCalledOnce();
});

test("keeps stop and Escape usable before rich output loads, preserving the conversation and draft", async () => {
  const request = deferred<{ default: typeof QuickChatConversation }>();
  conversationLoader.mockReturnValue(request.promise);
  await mount();
  await push({ session: { ...snapshot.session, runs: [run("running")] } });
  await type("keep this next question");
  await click(button("停止"));
  expect(bridge.stop).toHaveBeenCalledOnce();
  await key(input(), "Escape");
  expect(bridge.hide).toHaveBeenCalledOnce();
  expect(input().value).toBe("keep this next question");
  await act(async () => request.resolve({ default: QuickChatConversation }));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(document.activeElement).toBe(input());
  expect(state()).toBe("expanded");
  expect(container.textContent).toContain("hello");
  expect(input().value).toBe("keep this next question");
  expect(bridge.reset).not.toHaveBeenCalled();
});

test("resets while rich output is loading and ignores its late completion", async () => {
  const first = deferred<{ default: typeof QuickChatConversation }>();
  const second = deferred<{ default: typeof QuickChatConversation }>();
  conversationLoader.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  vi.mocked(bridge.reset).mockImplementation(async () => {
    emit({ session: emptySession("new-quick-session") });
    return ok();
  });
  await mount();
  await push({ session: { ...snapshot.session, runs: [run("running")] } });
  await type("old draft");
  await click(button("新对话"));
  expect(bridge.reset).toHaveBeenCalledOnce();
  expect(state()).toBe("compact");
  expect(input().value).toBe("");
  await type("new draft");
  await push({
    session: { ...snapshot.session, runs: [{ ...run("completed"), userMessage: "new session content" }] },
  });
  await act(async () => first.resolve({ default: QuickChatConversation }));
  expect(container.querySelector(".conversation")).toBeNull();
  expect(query('[role="status"]').textContent).toBe("正在加载对话…");
  expect(input().value).toBe("new draft");
  await act(async () => second.resolve({ default: QuickChatConversation }));
  expect(container.textContent).toContain("new session content");
  expect(container.textContent).not.toContain("hello");
  expect(input().value).toBe("new draft");
});

test("retries a failed rich output load without disabling stop, reset, Escape, or the draft", async () => {
  const request = deferred<{ default: typeof QuickChatConversation }>();
  conversationLoader
    .mockRejectedValueOnce(new Error("chunk unavailable"))
    .mockReturnValueOnce(request.promise);
  await mount();
  await push({ session: { ...snapshot.session, runs: [run("running")] } });
  expect(query('[role="alert"]').textContent).toContain("无法加载对话：chunk unavailable");
  expect(button("停止").disabled).toBe(false);
  expect(button("新对话").disabled).toBe(false);
  expect(container.querySelector('button[aria-label="隐藏"]')).toBeNull();
  await type("draft during retry");
  await click(query<HTMLButtonElement>(".quick-chat-conversation-placeholder .quick-chat-retry"));
  expect(conversationLoader).toHaveBeenCalledTimes(2);
  expect(query('[role="status"]').textContent).toBe("正在加载对话…");
  await click(button("停止"));
  expect(bridge.stop).toHaveBeenCalledOnce();
  await act(async () => request.resolve({ default: QuickChatConversation }));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("hello");
  expect(input().value).toBe("draft during retry");
});

test("ignores a failed rich output load after reset without reopening output or showing an error", async () => {
  const request = deferred<{ default: typeof QuickChatConversation }>();
  conversationLoader.mockReturnValueOnce(request.promise);
  vi.mocked(bridge.reset).mockImplementation(async () => {
    emit({ session: emptySession("reset-session") });
    return ok();
  });
  await mount();
  await push({ session: { ...snapshot.session, runs: [run("running")] } });
  await click(button("新对话"));
  await type("fresh draft");
  await act(async () => request.reject(new Error("stale chunk failure")));
  expect(state()).toBe("compact");
  expect(container.querySelector('[role="alert"], .conversation')).toBeNull();
  expect(input().value).toBe("fresh draft");
});

test.each(["resolve", "reject"] as const)(
  "ignores a rich output load that finishes with %s after the renderer unmounts",
  async (outcome) => {
    const request = deferred<{ default: typeof QuickChatConversation }>();
    const renderConversation = vi.fn(QuickChatConversation);
    conversationLoader.mockReturnValue(request.promise);
    await mount();
    await push({ session: { ...snapshot.session, runs: [run("completed")] } });
    await act(async () => root.render(null));
    await act(async () => {
      if (outcome === "resolve") request.resolve({ default: renderConversation });
      else request.reject(new Error("unmounted load failure"));
    });
    expect(container.childElementCount).toBe(0);
    expect(renderConversation).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  },
);

test("uses the real deferred module through the production loader", async () => {
  await act(async () => root.render(createElement(QuickChat)));
  await push({ session: { ...snapshot.session, runs: [run("completed")] } });
  await vi.waitFor(() => expect(container.textContent).toContain("hello"));
  expect(container.querySelector(".conversation")).not.toBeNull();
  expect(conversationLoader).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storageWrite).not.toHaveBeenCalled();
});

test("clears the draft and operation error only when an accepted snapshot changes session", async () => {
  vi.mocked(bridge.send).mockResolvedValue({ ok: false, error: { code: "provider", message: "旧对话错误" } });
  await mount();
  await type("old session draft");
  await key(input(), "Enter");
  await push();
  expect(input().value).toBe("old session draft");
  expect(query('[role="alert"]').textContent).toContain("旧对话错误");
  await key(input(), "Escape");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(input().value).toBe("old session draft");
  await push({ session: emptySession("expired-session-replacement") });
  expect(state()).toBe("compact");
  expect(input().value).toBe("");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(bridge.reset).not.toHaveBeenCalled();
});

test("isolates late send results from a replacement session and its pending send", async () => {
  const old = deferred<Result<void>>();
  const current = deferred<Result<void>>();
  vi.mocked(bridge.send).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await mount();
  await type("same text");
  await key(input(), "Enter");
  await push({ session: emptySession("replacement-session") });
  expect(input().value).toBe("");
  await type("same text");
  expect(button("发送").disabled).toBe(false);
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledTimes(2);
  await act(async () => old.resolve({ ok: false, error: { code: "provider", message: "old failure" } }));
  expect(input().value).toBe("same text");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(button("发送").disabled).toBe(true);
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledTimes(2);
  await act(async () => current.resolve(ok()));
  expect(input().value).toBe("");
});

test("keeps a new session's same-text draft when an old send succeeds late", async () => {
  const old = deferred<Result<void>>();
  vi.mocked(bridge.send).mockReturnValueOnce(old.promise);
  await mount();
  await type("same text");
  await key(input(), "Enter");
  await push({ session: emptySession("replacement-session") });
  await type("same text");
  await act(async () => old.resolve(ok()));
  expect(input().value).toBe("same text");
  expect(button("发送").disabled).toBe(false);
});

function sourcedRun(): QuickChatSnapshot["session"]["runs"][number] {
  return {
    ...run("completed"),
    orderedBlocks: [
      {
        id: "search",
        messageId: "search-message",
        type: "tool",
        toolCallId: "search-call",
        name: "web_search",
        argsText: "{}",
        status: "completed",
        output: "search output",
        web: {
          kind: "web_search",
          status: "success",
          results: [
            {
              url: "https://example.com/article",
              title: "Example article",
              snippet: "Example source excerpt",
              date: null,
              site_name: "Example",
              site_icon: "https://icons.example.com/favicon.ico",
            },
          ],
        },
      },
      { id: "answer", messageId: "answer-message", type: "text", text: "Answer from the source." },
    ],
    finalAnswerBlockIds: ["answer"],
  };
}

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6i0AAAAASUVORK5CYII=";

test("loads source favicons through the isolated bridge using the source page URL", async () => {
  vi.mocked(bridge.readWebSourceIcon).mockResolvedValue({ ok: true, value: { dataUrl: png } });
  await mount();
  await push({ session: { ...snapshot.session, runs: [sourcedRun()] } });
  expect(bridge.readWebSourceIcon).toHaveBeenCalledExactlyOnceWith(
    "quick-session",
    "run-1",
    "https://example.com/article",
  );
  expect(query<HTMLImageElement>(".answer-source-icon img").getAttribute("src")).toBe(png);
  expect(container.querySelector('img[src="https://icons.example.com/favicon.ico"]')).toBeNull();
});

test("keeps a globe fallback when the host rejects a source icon", async () => {
  vi.mocked(bridge.readWebSourceIcon).mockResolvedValue({
    ok: false,
    error: { code: "invalid_input", message: "source unavailable" },
  });
  await mount();
  await push({ session: { ...snapshot.session, sessionId: "rejected-icons", runs: [sourcedRun()] } });
  expect(bridge.readWebSourceIcon).toHaveBeenCalledOnce();
  expect(container.querySelector(".answer-source-icon img")).toBeNull();
  expect(container.querySelector(".answer-source-icon svg")).not.toBeNull();
  expect(container.textContent).toContain("Answer from the source.");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("ignores old-session link errors while still reporting current-session link errors", async () => {
  const old = deferred<Result<void>>();
  vi.mocked(bridge.openExternal)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ ok: false, error: { code: "invalid_input", message: "current link failure" } });
  await mount();
  await push({ session: { ...snapshot.session, runs: [sourcedRun()] } });
  await click(button("来源，1 个网页"));
  await click(query<HTMLButtonElement>(".answer-source-link"));
  expect(bridge.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/article");
  await push({ session: { ...emptySession("replacement-session"), runs: [sourcedRun()] } });
  await type("fresh session draft");
  await act(async () =>
    old.resolve({ ok: false, error: { code: "invalid_input", message: "old link failure" } }),
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(input().value).toBe("fresh session draft");
  await click(button("来源，1 个网页"));
  await click(query<HTMLButtonElement>(".answer-source-link"));
  expect(query('[role="alert"]').textContent).toContain("current link failure");
  expect(input().value).toBe("fresh session draft");
});

test("discards a late source icon when an expired session is replaced", async () => {
  const request = deferred<Result<{ dataUrl?: string }>>();
  vi.mocked(bridge.readWebSourceIcon).mockReturnValue(request.promise);
  await mount();
  await push({ session: { ...snapshot.session, sessionId: "late-icons", runs: [sourcedRun()] } });
  expect(bridge.readWebSourceIcon).toHaveBeenCalledOnce();
  await push({ session: emptySession("new-session") });
  await type("new session draft");
  await act(async () => request.resolve({ ok: true, value: { dataUrl: png } }));
  expect(state()).toBe("compact");
  expect(container.querySelector(".answer-source-icon, .conversation")).toBeNull();
  expect(input().value).toBe("new session draft");
});

test("ignores a source icon rejection after its session is replaced", async () => {
  const request = deferred<Result<{ dataUrl?: string }>>();
  vi.mocked(bridge.readWebSourceIcon).mockReturnValue(request.promise);
  await mount();
  await push({ session: { ...snapshot.session, sessionId: "late-icon-error", runs: [sourcedRun()] } });
  expect(bridge.readWebSourceIcon).toHaveBeenCalledOnce();
  await push({ session: emptySession("new-session") });
  await type("new session draft");
  await act(async () => request.reject(new Error("old source icon failure")));
  expect(state()).toBe("compact");
  expect(container.querySelector('[role="alert"], .answer-source-icon, .conversation')).toBeNull();
  expect(input().value).toBe("new session draft");
});

test("preserves the main conversation's source-icon context fallback", async () => {
  const unavailable = async () => {
    throw new Error("This test must not use attachments or file search");
  };
  const readWebSourceIcon = vi.fn(async () => png);
  await act(async () => {
    root.render(
      createElement(Conversation, {
        view: { ...snapshot.session, sessionId: "main-icon-session", runs: [sourcedRun()] },
        onLink() {},
        context: {
          searchFiles: unavailable,
          pickAttachments: unavailable,
          importAttachment: unavailable,
          removeAttachment: unavailable,
          readAttachment: unavailable,
          readWebSourceIcon,
        },
      }),
    );
  });
  expect(readWebSourceIcon).toHaveBeenCalledExactlyOnceWith(
    "main-icon-session",
    "run-1",
    "https://example.com/article",
  );
  expect(query<HTMLImageElement>(".answer-source-icon img").getAttribute("src")).toBe(png);
  expect(bridge.readWebSourceIcon).not.toHaveBeenCalled();
});

test("does not restore an old hide error after the session has been replaced", async () => {
  const request = deferred<Result<void>>();
  vi.mocked(bridge.hide).mockReturnValueOnce(request.promise);
  await mount();
  await key(input(), "Escape");
  await push({ session: emptySession("replacement-session") });
  await type("fresh session draft");
  await act(async () =>
    request.resolve({ ok: false, error: { code: "storage", message: "old hide failure" } }),
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(input().value).toBe("fresh session draft");
});
