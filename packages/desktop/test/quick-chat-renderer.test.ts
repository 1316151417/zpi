import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Conversation } from "zpi-ui";
import { emptySession } from "zpi-ui/projection";
import { QuickChat } from "../src/renderer/QuickChat.tsx";
import type { CombinedSelection, PublicSettings, Result } from "../src/shared/bridge.ts";
import { defaultCapabilities, defaultPreferences } from "../src/shared/config.ts";
import type { QuickChatBridge, QuickChatSnapshot } from "../src/shared/quick-chat.ts";
import { quickChatModels } from "../src/shared/quick-chat-settings.ts";
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
let storageWrite: ReturnType<typeof vi.spyOn>;

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
  await act(async () => root.render(createElement(QuickChat)));
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
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  listeners = new Set();
  bridge = {
    getSnapshot: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    send: vi.fn(async () => ok()),
    stop: vi.fn(async () => ok()),
    reset: vi.fn(async () => ok()),
    hide: vi.fn(async () => ok()),
    copyText: vi.fn(async () => ok()),
    openExternal: vi.fn(async () => ok()),
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
  await act(async () => root.unmount());
  expect(listeners.size).toBe(0);
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("opens as only a rounded input, using the theme and isolated bridge", async () => {
  await mount();
  expect(document.title).toBe("快速对话 · ZPI");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.dataset.quickChat).toBe("true");
  expect(document.documentElement.style.getPropertyValue("--ui-font-size")).toBe("15px");
  expect(state()).toBe("compact");
  expect(input().getAttribute("rows")).toBe("1");
  expect(input().disabled).toBe(false);
  expect(
    container.querySelector("header, button, .conversation, .composer-footer, .quick-chat-title"),
  ).toBeNull();
  expect(container.querySelector(".sidebar, .settings-screen, .composer-plus, .model-trigger")).toBeNull();
  expect(container.textContent).toBe("");
  expect("setSelection" in bridge).toBe(false);
  expect(storageWrite).not.toHaveBeenCalled();
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
  expect(button("停止")).toBeDefined();
  expect(
    container.querySelector('button[aria-label="发送"], .send, .model-trigger, .composer-footer'),
  ).toBeNull();
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
  expect(container.querySelector('button[aria-label="停止"], button[aria-label="发送"]')).toBeNull();
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
  expect(container.querySelector("header, button, .conversation")).toBeNull();
  expect("setSelection" in bridge).toBe(false);
});

test.each<{ label: string; selection: CombinedSelection | null }>([
  { label: "missing selection", selection: null },
  { label: "missing provider", selection: { provider: "missing", modelId: "first", reasoning: "none" } },
  { label: "disabled provider", selection: { provider: "disabled", modelId: "hidden", reasoning: "none" } },
  { label: "missing model", selection: { provider: "test", modelId: "missing", reasoning: "none" } },
  { label: "disabled model", selection: { provider: "test", modelId: "disabled", reasoning: "none" } },
  { label: "invalid reasoning", selection: { provider: "test", modelId: "first", reasoning: "high" } },
])("directs $label to settings and never sends or silently selects another model", async ({ selection }) => {
  snapshot = { ...snapshot, selection };
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
});

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
  expect(input().disabled).toBe(true);
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
