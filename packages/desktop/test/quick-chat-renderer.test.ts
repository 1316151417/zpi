import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { BrowserWindow, BrowserWindowConstructorOptions, Rectangle } from "electron";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type ImageAttachment, imageLimits } from "zpi-coding-agent/input";
import { Conversation } from "zpi-ui";
import { emptySession } from "zpi-ui/projection";
import type { QuickChatHost } from "../src/main/quick-chat-host.ts";
import { QuickChatWindow } from "../src/main/quick-chat-window.ts";
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
let composerProbeListeners: Set<(token: number, sessionId: string) => void>;
let storageWrite: ReturnType<typeof vi.spyOn>;
let conversationLoader: ReturnType<typeof vi.fn<() => Promise<{ default: typeof QuickChatConversation }>>>;

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element as T;
}
const imageMetadata = (id = "image-1", name = "clipboard.png"): ImageAttachment => ({
  id,
  name,
  mimeType: "image/png",
  width: 1,
  height: 1,
  size: 20,
});
const clipboardImage = (name = "clipboard.png") => new File(["png bytes"], name, { type: "image/png" });
const paste = async (files: File[] = [], text = "") => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      files,
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  await act(async () => {
    input().dispatchEvent(event);
  });
  return event;
};
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
const probe = async (token: number, sessionId = snapshot.session.sessionId) => {
  await act(async () => {
    for (const listener of composerProbeListeners) listener(token, sessionId);
  });
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
  composerProbeListeners = new Set();
  bridge = {
    getSnapshot: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    send: vi.fn(async () => ok()),
    importAttachment: vi.fn(async (_sessionId, file) => ({
      ok: true as const,
      value: imageMetadata(`image-${file.name}`, file.name),
    })),
    readAttachment: vi.fn(async (_sessionId, id) => ({
      ok: true as const,
      value: { metadata: imageMetadata(id), data: "aW1hZ2U=" },
    })),
    removeAttachment: vi.fn(async () => ok()),
    stop: vi.fn(async () => ok()),
    reset: vi.fn(async () => ok()),
    hide: vi.fn(async () => ok()),
    setComposerHeight: vi.fn(async () => ok()),
    rendererReady: vi.fn(async () => ok()),
    reportComposerState: vi.fn(async () => ok()),
    onComposerProbe: vi.fn((listener) => {
      composerProbeListeners.add(listener);
      return () => {
        composerProbeListeners.delete(listener);
      };
    }),
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
  expect(composerProbeListeners.size).toBe(0);
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

function quickChatStyles() {
  const style = document.createElement("style");
  style.textContent = [
    readFileSync(new URL("../../ui/src/tokens.css", import.meta.url), "utf8"),
    readFileSync(new URL("../../ui/src/styles.css", import.meta.url), "utf8"),
    readFileSync(new URL("../src/renderer/quick-chat.css", import.meta.url), "utf8"),
  ].join("\n");
  document.head.append(style);
  return style;
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

// The presentation integration uses the real renderer and window controller.
// Only native window operations and the model-independent session projection are fake.
function presentationHost() {
  let projection: QuickChatSnapshot = {
    ...snapshot,
    session: { ...snapshot.session, runs: [run("completed")] },
  };
  let hostListener: (next: QuickChatSnapshot) => void = () => {};
  let nextSession = 0;
  const publish = () => hostListener(projection);
  const host = {
    get sessionId() {
      return projection.session.sessionId;
    },
    getSnapshot: () => projection,
    subscribe: (listener: typeof hostListener) => {
      hostListener = listener;
      return () => {
        hostListener = () => {};
      };
    },
    reset: async () => {
      projection = {
        ...projection,
        revision: projection.revision + 1,
        session: emptySession(`new-session-${++nextSession}`),
      };
      publish();
    },
    resetIfExpired: () => undefined,
    close: async () => {},
    discardDraftAttachments: () => {},
  };
  const delivered: QuickChatSnapshot[] = [];
  function createNative(options: BrowserWindowConstructorOptions) {
    let bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 0,
      height: options.height ?? 0,
    };
    let visible = false;
    let focused = false;
    let destroyed = false;
    let url = "";
    const contents = Object.assign(new EventEmitter(), {
      session: Object.assign(new EventEmitter(), {
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
        webRequest: { onBeforeRequest: () => {} },
      }),
      isDestroyed: () => destroyed,
      getURL: () => url,
      setWindowOpenHandler: () => {},
      send: vi.fn((channel: string, ...args: unknown[]) => {
        if (channel === "zpi:quick-chat-snapshot") {
          const next = args[0] as QuickChatSnapshot;
          delivered.push(next);
          for (const listener of listeners) listener(next);
        } else if (channel === "zpi:quick-chat-composer") {
          for (const listener of composerProbeListeners) listener(args[0] as number, args[1] as string);
        } else if (channel === "zpi:quick-chat-presentation") {
          for (const listener of presentationListeners) listener(args[0] as number);
        }
      }),
    });
    const native = Object.assign(new EventEmitter(), {
      webContents: contents,
      isDestroyed: () => destroyed,
      isMinimized: () => false,
      isVisible: () => visible,
      isFocused: () => focused,
      getBounds: () => ({ ...bounds }),
      setBounds: (next: Rectangle) => {
        bounds = next;
      },
      setMinimumSize: () => {},
      restore: () => {},
      show: vi.fn(() => {
        visible = true;
        native.emit("show");
      }),
      focus: () => {
        focused = true;
        native.emit("focus");
      },
      hide: () => {
        visible = false;
        focused = false;
        native.emit("hide");
      },
      destroy: () => {
        destroyed = true;
        contents.emit("destroyed");
        native.emit("closed");
      },
      loadURL: async (next: string) => {
        url = next;
        queueMicrotask(() => contents.emit("did-finish-load"));
      },
    });
    return native;
  }
  let native!: ReturnType<typeof createNative>;
  const quick = new QuickChatWindow({
    host: host as unknown as QuickChatHost,
    createWindow: (options) => {
      native = createNative(options);
      return native as unknown as BrowserWindow;
    },
    rendererUrl: "file:///app/renderer/quick-chat.html",
    preload: "/app/preload/quick-chat.cjs",
    hiddenTestMode: false,
    platform: "linux",
    getDisplay: () => ({
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 25, width: 1440, height: 825 },
    }),
    copyText: () => {},
    openExternal: async () => {},
    loadSourceIcon: async () => undefined,
  });
  const call = <T>(method: string, args: unknown[] = []) => quick.call(method, args) as Promise<Result<T>>;
  vi.mocked(bridge.getSnapshot).mockImplementation(() => call<QuickChatSnapshot>("getSnapshot"));
  vi.mocked(bridge.reset).mockImplementation(() => call<void>("reset"));
  vi.mocked(bridge.hide).mockImplementation(() => call<void>("hide"));
  vi.mocked(bridge.setComposerHeight).mockImplementation((...args) => call<void>("setComposerHeight", args));
  vi.mocked(bridge.rendererReady).mockImplementation((...args) => call<void>("rendererReady", args));
  vi.mocked(bridge.reportComposerState).mockImplementation((...args) =>
    call<void>("reportComposerState", args),
  );
  return {
    quick,
    publish,
    delivered,
    get native() {
      return native;
    },
    get projection() {
      return projection;
    },
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
  expect(bridge.rendererReady).toHaveBeenCalledExactlyOnceWith("fresh-session", 0);
  await push();
  await frame();
  await frame();
  expect(bridge.rendererReady).toHaveBeenCalledOnce();
});

test("acknowledges the latest presentation version after a same-session mode change", async () => {
  const frame = animationClock();
  snapshot = { ...snapshot, expanded: true, presentationVersion: 3 };
  await mount();
  await frame();
  await push({ expanded: false, presentationVersion: 4 });
  expect(state()).toBe("compact");
  await frame();
  expect(bridge.rendererReady).not.toHaveBeenCalled();
  await frame();
  expect(bridge.rendererReady).toHaveBeenCalledExactlyOnceWith("quick-session", 4);
  await push();
  await frame();
  await frame();
  expect(bridge.rendererReady).toHaveBeenCalledOnce();
});

test("probes live blank, typed, whitespace, and deleted drafts without transmitting their contents", async () => {
  await mount();
  await probe(1);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(1, "quick-session", false);
  // A native edit may occur immediately before React handles its input event.
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(
    input(),
    "private unsent draft",
  );
  await probe(2);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(2, "quick-session", true);
  await type(" ");
  await probe(3);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(3, "quick-session", true);
  await type("");
  await probe(4);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(4, "quick-session", false);
  await push();
  await push({ session: emptySession("fresh-session") });
  await probe(5, "quick-session");
  expect(bridge.reportComposerState).toHaveBeenCalledTimes(4);
  await probe(6, "fresh-session");
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(6, "fresh-session", false);
  expect(bridge.onComposerProbe).toHaveBeenCalledOnce();
  expect(vi.mocked(bridge.reportComposerState).mock.calls.every((call) => call.length === 3)).toBe(true);
});

test("probes queued, importing, failed, ready, and removing images as occupied until removal completes", async () => {
  const request = deferred<Result<QuickChatSnapshot>>();
  const importing = deferred<Result<ImageAttachment>>();
  vi.mocked(bridge.getSnapshot).mockReturnValue(request.promise);
  vi.mocked(bridge.importAttachment).mockReturnValueOnce(importing.promise);
  await mount();
  await paste([clipboardImage()]);
  await probe(1);
  expect(bridge.reportComposerState).not.toHaveBeenCalled();
  expect(bridge.importAttachment).not.toHaveBeenCalled();
  // The accepted session is known before queued imports' effects get a chance to run.
  await act(async () => {
    emit();
    for (const listener of composerProbeListeners) listener(2, "quick-session");
  });
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(2, "quick-session", true);
  expect(bridge.importAttachment).toHaveBeenCalledOnce();
  await probe(3);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(3, "quick-session", true);
  await act(async () =>
    importing.resolve({ ok: false, error: { code: "invalid_input", message: "图片损坏" } }),
  );
  await probe(4);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(4, "quick-session", true);
  await click(button("重试 clipboard.png"));
  await probe(5);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(5, "quick-session", true);
  const removing = deferred<Result<void>>();
  vi.mocked(bridge.removeAttachment).mockReturnValueOnce(removing.promise);
  await click(button("移除 clipboard.png"));
  await probe(6);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(6, "quick-session", true);
  await act(async () => removing.resolve(ok()));
  await probe(7);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(7, "quick-session", false);
});

test("keeps a pending send and its retryable error occupied after the user clears the draft", async () => {
  const request = deferred<Result<void>>();
  vi.mocked(bridge.send).mockReturnValueOnce(request.promise);
  await mount();
  await type("send this");
  await key(input(), "Enter");
  await type("");
  await probe(1);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(1, "quick-session", true);
  await act(async () => request.resolve({ ok: false, error: { code: "provider", message: "稍后重试" } }));
  expect(input().value).toBe("");
  await probe(2);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(2, "quick-session", true);
  await click(button("关闭提示"));
  await probe(3);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(3, "quick-session", false);
  await type("retry this");
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledTimes(2);
  await probe(4);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(4, "quick-session", false);
});

test.each(["reset", "stop"] as const)("keeps a pending %s occupied even with no draft", async (action) => {
  const request = deferred<Result<void>>();
  vi.mocked(bridge[action]).mockReturnValueOnce(request.promise);
  snapshot = {
    ...snapshot,
    expanded: true,
    session: { ...snapshot.session, runs: action === "stop" ? [run("running")] : [] },
  };
  await mount();
  await click(button(action === "reset" ? "新对话" : "停止"));
  await probe(1);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(1, "quick-session", true);
  await act(async () => request.resolve(ok()));
  await probe(2);
  expect(bridge.reportComposerState).toHaveBeenLastCalledWith(2, "quick-session", false);
});

test("does not treat the permanent model configuration notice as occupied", async () => {
  snapshot = { ...snapshot, expanded: true, selection: null };
  await mount();
  expect(query(".quick-chat-configuration")).toBeDefined();
  await probe(1);
  expect(bridge.reportComposerState).toHaveBeenCalledExactlyOnceWith(1, "quick-session", false);
});

test("bridges visible history, new empty conversation, hidden resume, and compact frame acknowledgement", async () => {
  const frame = animationClock();
  const f = presentationHost();
  try {
    await f.quick.show();
    await mount();
    await frame();
    await frame();
    expect(state()).toBe("expanded");
    expect(container.textContent).toContain("hello");
    expect(f.native.getBounds()).toMatchObject({ width: 660, height: 560 });
    await click(button("新对话"));
    expect(f.projection.session.runs).toHaveLength(0);
    expect(f.projection.session.sessionId).toBe("new-session-1");
    expect(state()).toBe("expanded");
    expect(f.native.getBounds()).toMatchObject({ width: 660, height: 560 });
    expect(input().value).toBe("");
    await frame();
    await frame();
    const oldPresentation = f.delivered.at(-1) as QuickChatSnapshot;
    await key(input(), "Escape");
    expect(f.native.isVisible()).toBe(false);
    f.native.show.mockClear();
    let opening!: Promise<void>;
    await act(async () => {
      opening = f.quick.show();
    });
    expect(bridge.reportComposerState).toHaveBeenLastCalledWith(expect.any(Number), "new-session-1", false);
    expect(state()).toBe("compact");
    const compact = f.delivered.at(-1) as QuickChatSnapshot;
    expect(compact.presentationVersion).toBeGreaterThan(oldPresentation.presentationVersion as number);
    expect(compact.revision).toBeGreaterThan(oldPresentation.revision);
    expect(f.native.show).not.toHaveBeenCalled();
    await f.quick.call("rendererReady", ["new-session-1", oldPresentation.presentationVersion]);
    await frame();
    expect(f.native.show).not.toHaveBeenCalled();
    await frame();
    await opening;
    expect(bridge.rendererReady).toHaveBeenLastCalledWith("new-session-1", compact.presentationVersion);
    expect(f.native.show).toHaveBeenCalledOnce();
    expect(f.native.getBounds()).toMatchObject({ width: 360, height: 44 });
    expect(f.native.isVisible()).toBe(true);
    expect(input().disabled).toBe(false);
  } finally {
    await f.quick.dispose();
  }
});

test.each(["text", "image"] as const)(
  "bridges a preserved %s draft across expanded resume and compacts after it is cleared",
  async (kind) => {
    const frame = animationClock();
    const f = presentationHost();
    try {
      await f.quick.show();
      await mount();
      await click(button("新对话"));
      await frame();
      await frame();
      if (kind === "text") await type("unsent local draft");
      else await paste([clipboardImage()]);
      await key(input(), "Escape");
      await act(async () => {
        await f.quick.show();
      });
      expect(bridge.reportComposerState).toHaveBeenLastCalledWith(expect.any(Number), "new-session-1", true);
      expect(state()).toBe("expanded");
      expect(f.native.getBounds()).toMatchObject({ width: 660, height: 560 });
      if (kind === "text") {
        expect(input().value).toBe("unsent local draft");
        await type("");
      } else {
        expect(button("预览 clipboard.png").disabled).toBe(false);
        await click(button("移除 clipboard.png"));
      }
      await key(input(), "Escape");
      let opening!: Promise<void>;
      await act(async () => {
        opening = f.quick.show();
      });
      expect(bridge.reportComposerState).toHaveBeenLastCalledWith(expect.any(Number), "new-session-1", false);
      expect(state()).toBe("compact");
      expect(f.native.isVisible()).toBe(false);
      await frame();
      await frame();
      await opening;
      expect(f.native.getBounds()).toMatchObject({ width: 360, height: 44 });
      expect(f.native.isVisible()).toBe(true);
      expect(bridge.send).not.toHaveBeenCalled();
    } finally {
      await f.quick.dispose();
    }
  },
);

test("rejects a late expanded getSnapshot after a newer compact presentation of the same host revision", async () => {
  const frame = animationClock();
  const f = presentationHost();
  try {
    await f.quick.show();
    await f.quick.call("reset", []);
    const hostRevision = f.projection.revision;
    const oldResponse = await bridge.getSnapshot();
    const request = deferred<Result<QuickChatSnapshot>>();
    vi.mocked(bridge.getSnapshot).mockReturnValueOnce(request.promise);
    await mount();
    await act(async () => f.publish());
    expect(state()).toBe("expanded");
    await frame();
    await frame();
    await key(input(), "Escape");
    let opening!: Promise<void>;
    await act(async () => {
      opening = f.quick.show();
    });
    await frame();
    await frame();
    await opening;
    expect(f.projection.revision).toBe(hostRevision);
    expect(state()).toBe("compact");
    await act(async () => request.resolve(oldResponse));
    expect(state()).toBe("compact");
    expect(f.native.getBounds()).toMatchObject({ width: 360, height: 44 });
    expect(f.projection.session.sessionId).toBe("new-session-1");
    await type("still usable after the late reply");
    expect(input().value).toBe("still usable after the late reply");
  } finally {
    await f.quick.dispose();
  }
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
  const style = quickChatStyles();
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

test("pastes an image, shows its thumbnail and sends image-only input using an attachment id", async () => {
  await mount();
  const file = clipboardImage();
  const event = await paste([file]);
  expect(event.defaultPrevented).toBe(true);
  expect(bridge.importAttachment).toHaveBeenCalledExactlyOnceWith("quick-session", file);
  expect(bridge.readAttachment).toHaveBeenCalledExactlyOnceWith("quick-session", "image-clipboard.png");
  const thumbnail = query<HTMLImageElement>(".quick-chat-attachment img");
  expect(thumbnail.src).toBe("data:image/png;base64,aW1hZ2U=");
  expect(thumbnail.alt).toBe(file.name);
  expect(query(".quick-chat-attachment").textContent).toBe("");
  expect(container.querySelector(".quick-chat-attachment-status")).toBeNull();
  expect(button(`预览 ${file.name}`).disabled).toBe(false);
  expect(button(`移除 ${file.name}`).disabled).toBe(false);
  expect(button("发送").disabled).toBe(false);
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 100);
  expect(conversationLoader).not.toHaveBeenCalled();
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledExactlyOnceWith("", ["image-clipboard.png"]);
  expect(container.querySelector(".quick-chat-attachments")).toBeNull();
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 44);
  expect(bridge.removeAttachment).not.toHaveBeenCalled();
});

test.each([
  { expanded: false, count: 1 },
  { expanded: false, count: imageLimits.count },
  { expanded: true, count: 1 },
  { expanded: true, count: imageLimits.count },
])(
  "uses a thumbnail-sized single row for $count images (expanded: $expanded)",
  async ({ expanded, count }) => {
    const style = quickChatStyles();
    try {
      await mount();
      if (expanded) await push({ expanded: true });
      container.style.width = "240px";
      vi.mocked(bridge.setComposerHeight).mockClear();
      await paste(Array.from({ length: count }, (_, index) => clipboardImage(`${index}.png`)));
      const row = getComputedStyle(query(".quick-chat-attachments"));
      expect(row.display).toBe("flex");
      expect(row.flexWrap).toBe("nowrap");
      expect(row.height).toBe("48px");
      expect(row.gap).toBe("8px");
      expect(row.overflowX).toBe("auto");
      expect(row.overflowY).toBe("hidden");
      expect(row.scrollbarWidth).toBe("none");
      expect(getComputedStyle(query(".quick-chat-composer")).gap).toBe("8px");
      const attachments = [...container.querySelectorAll(".quick-chat-attachment")];
      expect(attachments).toHaveLength(count);
      for (const attachment of attachments) {
        const css = getComputedStyle(attachment);
        expect(css.flexBasis).toBe("48px");
        expect(css.flexShrink).toBe("0");
        expect(css.height).toBe("48px");
        const chip = attachment.querySelector(".image-chip") as HTMLElement;
        expect(getComputedStyle(chip).display).toBe("flex");
        expect(getComputedStyle(chip).height).toBe("48px");
        const preview = chip.firstElementChild as HTMLButtonElement;
        expect(getComputedStyle(preview).height).toBe("48px");
        expect(getComputedStyle(preview).padding).toBe("0px");
        expect(getComputedStyle(preview.querySelector("img") as HTMLImageElement).height).toBe("48px");
        expect(attachment.querySelector(".quick-chat-attachment-status")).toBeNull();
      }
      if (expanded) expect(bridge.setComposerHeight).not.toHaveBeenCalled();
      else expect(bridge.setComposerHeight).toHaveBeenCalledExactlyOnceWith("quick-session", 100);
      // These CSS contracts keep narrow layouts horizontal; happy-dom does not measure overflow pixels.
      const taskChip = document.createElement("div");
      taskChip.className = "image-chip";
      container.append(taskChip);
      expect(getComputedStyle(taskChip).display).toBe("inline-flex");
      await click(button("移除 0.png"));
      if (count > 1) {
        expect(container.querySelectorAll(".quick-chat-attachment")).toHaveLength(count - 1);
        if (!expanded) expect(bridge.setComposerHeight).toHaveBeenCalledOnce();
      } else if (!expanded) {
        expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 44);
      }
    } finally {
      style.remove();
    }
  },
);

test("overlays processing and retry controls without adding a status row or native height", async () => {
  const style = quickChatStyles();
  const importing = deferred<Result<ImageAttachment>>();
  vi.mocked(bridge.importAttachment).mockReturnValueOnce(importing.promise);
  snapshot = { ...snapshot, settings: { ...settings, interface: { ...settings.interface, fontSize: 20 } } };
  try {
    await mount();
    expect(document.documentElement.style.getPropertyValue("--ui-font-size")).toBe("20px");
    await paste([clipboardImage()]);
    const expectOverlay = () => {
      const status = getComputedStyle(query(".quick-chat-attachment-status"));
      expect(status.position).toBe("absolute");
      expect(status.bottom).toBe("0px");
      expect(status.height).toBe("20px");
      expect(status.lineHeight).toBe("20px");
      expect(status.width).toBe("48px");
      expect(getComputedStyle(query(".quick-chat-attachment")).position).toBe("relative");
      const remove = getComputedStyle(button("移除 clipboard.png"));
      expect(remove.top).toBe("2px");
      expect(remove.height).toBe("14px");
      expect(bridge.setComposerHeight).toHaveBeenCalledTimes(2);
      expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 100);
    };
    expectOverlay();
    expect(button("移除 clipboard.png").disabled).toBe(false);
    await act(async () =>
      importing.resolve({ ok: false, error: { code: "invalid_input", message: "图片损坏" } }),
    );
    expectOverlay();
    expect(button("重试 clipboard.png").disabled).toBe(false);
    await click(button("重试 clipboard.png"));
    expect(container.querySelector(".quick-chat-attachment-status")).toBeNull();
    expect(button("预览 clipboard.png").disabled).toBe(false);
    expect(bridge.setComposerHeight).toHaveBeenCalledTimes(2);
    const removing = deferred<Result<void>>();
    vi.mocked(bridge.removeAttachment).mockReturnValueOnce(removing.promise);
    await click(button("移除 clipboard.png"));
    expectOverlay();
    expect(button("移除 clipboard.png").disabled).toBe(true);
    await act(async () => removing.resolve({ ok: false, error: { code: "busy", message: "稍后移除" } }));
    expectOverlay();
    expect(button("重试 clipboard.png").disabled).toBe(false);
    await click(button("重试 clipboard.png"));
    expect(container.querySelector(".quick-chat-attachments")).toBeNull();
    expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 44);
  } finally {
    style.remove();
  }
});

test("keeps draft image preview and dismissal available without a filename below the thumbnail", async () => {
  await mount();
  await paste([clipboardImage()]);
  await click(button("预览 clipboard.png"));
  const dialog = query<HTMLDialogElement>('dialog[aria-label="图片预览"]');
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector("img")?.alt).toBe("clipboard.png");
  await click(button("关闭图片预览"));
  expect(container.querySelector("dialog")).toBeNull();
  expect(query(".quick-chat-attachment").textContent).toBe("");
  await click(button("预览 clipboard.png"));
  await key(query("dialog"), "Escape");
  expect(container.querySelector("dialog")).toBeNull();
  expect(query(".quick-chat-attachment").textContent).toBe("");
  expect(bridge.hide).not.toHaveBeenCalled();
});

test("keeps plain text and data URLs on the browser paste path, without importing images", async () => {
  await mount();
  expect((await paste([], "ordinary text")).defaultPrevented).toBe(false);
  expect((await paste([], "data:image/png;base64,arbitrary")).defaultPrevented).toBe(false);
  expect((await paste([new File(["text"], "note.txt", { type: "text/plain" })])).defaultPrevented).toBe(
    false,
  );
  expect(bridge.importAttachment).not.toHaveBeenCalled();
  expect(bridge.readAttachment).not.toHaveBeenCalled();
});

test("inserts mixed clipboard text at the selection and sends it with the image", async () => {
  await mount();
  await type("before OLD after");
  input().setSelectionRange(7, 10);
  await paste([clipboardImage()], "new\ntext");
  expect(input().value).toBe("before new\ntext after");
  await key(input(), "Enter", { shiftKey: true });
  expect(bridge.send).not.toHaveBeenCalled();
  await composition("compositionstart");
  await key(input(), "Enter");
  expect(bridge.send).not.toHaveBeenCalled();
  await composition("compositionend");
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledExactlyOnceWith("before new\ntext after", ["image-clipboard.png"]);
});

test("retains early text and queued clipboard images when the first snapshot arrives", async () => {
  const request = deferred<Result<QuickChatSnapshot>>();
  vi.mocked(bridge.getSnapshot).mockReturnValue(request.promise);
  await mount();
  await type("before connection");
  await paste([clipboardImage()]);
  expect(bridge.importAttachment).not.toHaveBeenCalled();
  expect(query(".quick-chat-attachment-status").textContent).toBe("处理中…");
  expect(query(".quick-chat-attachment").textContent).not.toContain("clipboard.png");
  expect(button("发送").disabled).toBe(true);
  await act(async () => request.resolve({ ok: true, value: snapshot }));
  expect(input().value).toBe("before connection");
  expect(bridge.importAttachment).toHaveBeenCalledOnce();
  expect(container.querySelector(".quick-chat-attachment-status")).toBeNull();
  expect(button("发送").disabled).toBe(false);
});

test("reserves the image count across consecutive pastes while imports are pending", async () => {
  const request = deferred<Result<ImageAttachment>>();
  vi.mocked(bridge.importAttachment).mockReturnValue(request.promise);
  await mount();
  for (let index = 0; index < imageLimits.count + 2; index += 1)
    await paste([clipboardImage(`${index}.png`)]);
  expect(bridge.importAttachment).toHaveBeenCalledTimes(imageLimits.count);
  expect(container.querySelectorAll(".quick-chat-attachment")).toHaveLength(imageLimits.count);
  expect(
    [...container.querySelectorAll(".quick-chat-attachment-status")].map((item) => item.textContent),
  ).toEqual(Array(imageLimits.count).fill("处理中…"));
  expect(query('[role="alert"]').textContent).toContain("最多可添加 8 张图片");
  await type("wait for images");
  await key(input(), "Enter");
  expect(bridge.send).not.toHaveBeenCalled();
  expect(button("发送").disabled).toBe(true);
});

test("keeps a rejected clipboard file and text for an explicit import retry", async () => {
  vi.mocked(bridge.importAttachment).mockResolvedValueOnce({
    ok: false,
    error: { code: "invalid_input", message: "图片损坏" },
  });
  await mount();
  await type("keep my text");
  const file = clipboardImage();
  await paste([file]);
  expect(input().value).toBe("keep my text");
  expect(container.querySelector(".quick-chat-attachment img")).toBeNull();
  expect(query('[role="alert"]').textContent).toContain("图片损坏");
  expect(button("重试 clipboard.png").textContent).toBe("重试");
  expect(button("重试 clipboard.png").title).toBe("图片损坏");
  expect(query(".quick-chat-attachment").textContent).not.toContain("clipboard.png");
  expect(button("发送").disabled).toBe(true);
  await click(button("重试 clipboard.png"));
  expect(bridge.importAttachment).toHaveBeenNthCalledWith(2, "quick-session", file);
  expect(container.querySelector(".quick-chat-attachment-status")).toBeNull();
  expect(button("发送").disabled).toBe(false);
});

test.each([0, imageLimits.sourceBytes + 1])(
  "rejects a %s-byte file before calling the import bridge",
  async (size) => {
    await mount();
    const file = clipboardImage();
    Object.defineProperty(file, "size", { value: size });
    await paste([file]);
    expect(bridge.importAttachment).not.toHaveBeenCalled();
    expect(button("重试 clipboard.png")).toBeDefined();
    expect(button("发送").disabled).toBe(true);
    await click(button("移除 clipboard.png"));
    expect(container.querySelector(".quick-chat-attachments")).toBeNull();
  },
);

test("retries a thumbnail read without reimporting its validated attachment", async () => {
  vi.mocked(bridge.readAttachment).mockResolvedValueOnce({
    ok: false,
    error: { code: "not_found", message: "暂时无法预览" },
  });
  await mount();
  await paste([clipboardImage()]);
  expect(button("重试 clipboard.png").title).toContain("暂时无法预览");
  expect(button("重试 clipboard.png").textContent).toBe("重试");
  expect(query(".quick-chat-attachment").textContent).not.toContain("clipboard.png");
  expect(button("发送").disabled).toBe(false);
  await click(button("重试 clipboard.png"));
  expect(bridge.importAttachment).toHaveBeenCalledOnce();
  expect(bridge.readAttachment).toHaveBeenCalledTimes(2);
  expect(container.querySelector(".quick-chat-attachment img")).not.toBeNull();
  expect(container.querySelector(".quick-chat-attachment-status")).toBeNull();
});

test("shows processing while removing an image and keeps the accessible filename", async () => {
  const request = deferred<Result<void>>();
  vi.mocked(bridge.removeAttachment).mockReturnValueOnce(request.promise);
  await mount();
  await paste([clipboardImage()]);
  await click(button("移除 clipboard.png"));
  expect(query(".quick-chat-attachment-status").textContent).toBe("处理中…");
  expect(query(".quick-chat-attachment").textContent).not.toContain("clipboard.png");
  expect(button("移除 clipboard.png").disabled).toBe(true);
  await act(async () => request.resolve(ok()));
  expect(container.querySelector(".quick-chat-attachments")).toBeNull();
});

test("keeps an image when removal fails, then allows a removal retry", async () => {
  vi.mocked(bridge.removeAttachment).mockResolvedValueOnce({
    ok: false,
    error: { code: "busy", message: "稍后移除" },
  });
  await mount();
  await paste([clipboardImage()]);
  await click(button("移除 clipboard.png"));
  expect(container.querySelector(".quick-chat-attachment img")).not.toBeNull();
  expect(query('[role="alert"]').textContent).toContain("稍后移除");
  await click(button("重试 clipboard.png"));
  expect(bridge.removeAttachment).toHaveBeenCalledTimes(2);
  expect(container.querySelector(".quick-chat-attachments")).toBeNull();
});

test("removes a pending placeholder and cleans up its eventual import without restoring it", async () => {
  const request = deferred<Result<ImageAttachment>>();
  vi.mocked(bridge.importAttachment).mockReturnValue(request.promise);
  await mount();
  await paste([clipboardImage()]);
  await click(button("移除 clipboard.png"));
  await act(async () => request.resolve({ ok: true, value: imageMetadata("late-import") }));
  expect(bridge.removeAttachment).toHaveBeenCalledExactlyOnceWith("quick-session", "late-import");
  expect(container.querySelector(".quick-chat-attachments")).toBeNull();
});

test("caps the compact image composer at 240px and shrinks with text and image removal", async () => {
  await mount();
  measureInput(() => input().value.split("\n").length * 24);
  await paste([clipboardImage()]);
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 100);
  await type(Array.from({ length: 12 }, () => "line").join("\n"));
  expect(input().style.height).toBe("168px");
  expect(input().style.overflowY).toBe("auto");
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 240);
  await type("first\nsecond");
  expect(input().style.height).toBe("48px");
  expect(input().style.overflowY).toBe("hidden");
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 120);
  await type("");
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 100);
  await type(Array.from({ length: 12 }, () => "line").join("\n"));
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 240);
  await click(button("移除 clipboard.png"));
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 184);
  await type("");
  expect(bridge.setComposerHeight).toHaveBeenLastCalledWith("quick-session", 44);
});

test("preserves hidden images and clears them on a manual reset that stays expanded", async () => {
  await mount();
  await push({ expanded: true });
  expect(state()).toBe("expanded");
  expect(button("新对话")).toBeDefined();
  expect(conversationLoader).not.toHaveBeenCalled();
  await type("draft");
  await paste([clipboardImage()]);
  await key(input(), "Escape");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(input().value).toBe("draft");
  expect(container.querySelector(".quick-chat-attachment img")).not.toBeNull();
  vi.mocked(bridge.reset).mockImplementation(async () => {
    emit({ session: emptySession("manual-reset"), expanded: true });
    return ok();
  });
  await click(button("新对话"));
  expect(state()).toBe("expanded");
  expect(input().value).toBe("");
  expect(button("新对话")).toBeDefined();
  expect(container.querySelector(".quick-chat-attachments")).toBeNull();
  expect(conversationLoader).not.toHaveBeenCalled();
});

test("retains text and images on send rejection and retries with the same ids", async () => {
  vi.mocked(bridge.send).mockResolvedValueOnce({
    ok: false,
    error: { code: "configuration", message: "当前模型不支持图片" },
  });
  await mount();
  await type("describe this");
  await paste([clipboardImage()]);
  await key(input(), "Enter");
  expect(input().value).toBe("describe this");
  expect(container.querySelector(".quick-chat-attachment img")).not.toBeNull();
  expect(query('[role="alert"]').textContent).toContain("当前模型不支持图片");
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenNthCalledWith(2, "describe this", ["image-clipboard.png"]);
  expect(bridge.importAttachment).toHaveBeenCalledOnce();
  expect(input().value).toBe("");
});

test("restores the untouched text and images after an accepted send fails at the provider", async () => {
  vi.mocked(bridge.send).mockImplementation(async () => {
    emit({ session: { ...snapshot.session, runs: [run("running")] } });
    return ok();
  });
  await mount();
  await type("retry me");
  await paste([clipboardImage()]);
  await key(input(), "Enter");
  expect(input().value).toBe("");
  expect(container.querySelector(".quick-chat-attachments")).toBeNull();
  await push({
    session: { ...snapshot.session, runs: [{ ...run("completed"), status: "error", error: "离线" }] },
  });
  expect(input().value).toBe("retry me");
  expect(container.querySelector(".quick-chat-attachment img")).not.toBeNull();
  expect(query('[role="alert"]').textContent).toContain("离线");
});

test("does not overwrite a newer draft or image after the previous accepted send fails", async () => {
  vi.mocked(bridge.send).mockImplementation(async () => {
    emit({ session: { ...snapshot.session, runs: [run("running")] } });
    return ok();
  });
  await mount();
  await type("old text");
  await paste([clipboardImage("old.png")]);
  await key(input(), "Enter");
  await type("new text");
  await paste([clipboardImage("new.png")]);
  await push({ session: { ...snapshot.session, runs: [{ ...run("completed"), status: "error" }] } });
  expect(input().value).toBe("new text");
  expect(container.querySelector('img[alt="new.png"]')).not.toBeNull();
  expect(container.querySelector('img[alt="old.png"]')).toBeNull();
});

test.each(["resolve", "reject"] as const)(
  "ignores an old session's %s after image import",
  async (outcome) => {
    const request = deferred<Result<ImageAttachment>>();
    vi.mocked(bridge.importAttachment).mockReturnValueOnce(request.promise);
    await mount();
    await paste([clipboardImage("old.png")]);
    await push({ session: emptySession("replacement") });
    await type("new text");
    await paste([clipboardImage("new.png")]);
    await act(async () => {
      if (outcome === "resolve") request.resolve({ ok: true, value: imageMetadata("old-image") });
      else request.reject(new Error("old import failure"));
    });
    expect(input().value).toBe("new text");
    expect(container.querySelector('img[alt="new.png"]')).not.toBeNull();
    expect(container.querySelector('img[alt="old.png"], [role="alert"]')).toBeNull();
  },
);

test.each(["read", "remove"] as const)("ignores an old session's late image %s failure", async (action) => {
  const request = deferred<Result<never>>();
  if (action === "read") vi.mocked(bridge.readAttachment).mockReturnValueOnce(request.promise);
  else vi.mocked(bridge.removeAttachment).mockReturnValueOnce(request.promise);
  await mount();
  await paste([clipboardImage("old.png")]);
  if (action === "remove") await click(button("移除 old.png"));
  await push({ session: emptySession("replacement") });
  await paste([clipboardImage("new.png")]);
  await act(async () => request.reject(new Error(`old ${action} failure`)));
  expect(container.querySelector('img[alt="new.png"]')).not.toBeNull();
  expect(container.querySelector('img[alt="old.png"], [role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain("重试");
});

test("preserves images pasted while a send is pending and ignores an old session's send result", async () => {
  const request = deferred<Result<void>>();
  vi.mocked(bridge.send).mockReturnValueOnce(request.promise);
  await mount();
  await paste([clipboardImage("sent.png")]);
  await key(input(), "Enter");
  await paste([clipboardImage("next.png")]);
  await act(async () => request.resolve(ok()));
  expect(container.querySelector('img[alt="sent.png"]')).toBeNull();
  expect(container.querySelector('img[alt="next.png"]')).not.toBeNull();
  const old = deferred<Result<void>>();
  vi.mocked(bridge.send).mockReturnValueOnce(old.promise);
  await key(input(), "Enter");
  await push({ session: emptySession("replacement") });
  await paste([clipboardImage("next.png")]);
  await act(async () => old.resolve(ok()));
  expect(container.querySelector('img[alt="next.png"]')).not.toBeNull();
});

test("renders history images through the dedicated attachment bridge", async () => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        this.callback(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
    },
  );
  await mount();
  await push({
    session: {
      ...snapshot.session,
      runs: [{ ...run("completed"), attachments: [imageMetadata("history-image")] }],
    },
  });
  expect(bridge.readAttachment).toHaveBeenCalledExactlyOnceWith("quick-session", "history-image");
  expect(query<HTMLImageElement>(".message-images img").src).toBe("data:image/png;base64,aW1hZ2U=");
});

test("releases ready draft images and late successful imports when the renderer unmounts", async () => {
  const request = deferred<Result<ImageAttachment>>();
  await mount();
  await paste([clipboardImage("ready.png")]);
  vi.mocked(bridge.importAttachment).mockReturnValueOnce(request.promise);
  await paste([clipboardImage("pending.png")]);
  await act(async () => root.render(null));
  expect(bridge.removeAttachment).toHaveBeenCalledWith("quick-session", "image-ready.png");
  await act(async () => request.resolve({ ok: true, value: imageMetadata("late-import") }));
  expect(bridge.removeAttachment).toHaveBeenCalledWith("quick-session", "late-import");
  expect(container.childElementCount).toBe(0);
});

test("keeps image input scrollable under a clamped compact display and reserves send-control space", async () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../src/renderer/quick-chat.css", import.meta.url), "utf8");
  document.head.append(style);
  try {
    await mount();
    measureInput(
      () => 240,
      () => 28,
    );
    await paste([clipboardImage()]);
    await type("long input on an 80px-tall display");
    expect(input().style.overflowY).toBe("auto");
    expect(getComputedStyle(query(".quick-chat-composer-input-row")).minHeight).toBe("28px");
    expect(getComputedStyle(query(".quick-chat-composer-input-row")).flexShrink).toBe("0");
    expect(Number.parseFloat(getComputedStyle(query(".quick-chat-attachments")).minHeight)).toBe(0);
    expect(getComputedStyle(query(".quick-chat-attachments")).overflowY).toBe("hidden");
    expect(getComputedStyle(button("发送")).height).toBe("28px");
    expect(button("发送").disabled).toBe(false);
  } finally {
    style.remove();
  }
});

test("recovers an image-only provider failure that arrives before the send reply", async () => {
  const request = deferred<Result<void>>();
  vi.mocked(bridge.send).mockImplementation(() => {
    emit({
      session: { ...snapshot.session, runs: [{ ...run("completed"), status: "error", error: "发送失败" }] },
    });
    return request.promise;
  });
  await mount();
  await paste([clipboardImage()]);
  await key(input(), "Enter");
  await act(async () => request.resolve(ok()));
  expect(input().value).toBe("");
  expect(container.querySelector(".quick-chat-attachment img")).not.toBeNull();
  expect(button("发送").disabled).toBe(false);
  expect(query('[role="alert"]').textContent).toContain("发送失败");
});

test("keeps an emergency small-display layout for the expanded input and send row", () => {
  const css = readFileSync(new URL("../src/renderer/quick-chat.css", import.meta.url), "utf8");
  const compactViewportRules = css.slice(css.indexOf("@media (max-height: 140px)"));
  expect(compactViewportRules).toContain(".quick-chat-expanded .quick-chat-composer-container");
  expect(compactViewportRules).toContain("padding-block: 0");
  expect(compactViewportRules).toContain("padding-block: 2px");
  expect(compactViewportRules).toContain("gap: 0");
  expect(compactViewportRules).toContain("min-height: 28px");
});
