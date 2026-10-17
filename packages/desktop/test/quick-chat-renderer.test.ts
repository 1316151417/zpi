import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Conversation } from "zpi-ui";
import { emptySession } from "zpi-ui/projection";
import { QuickChat } from "../src/renderer/QuickChat.tsx";
import type { PublicSettings, Result } from "../src/shared/bridge.ts";
import { defaultCapabilities, defaultPreferences } from "../src/shared/config.ts";
import type { QuickChatBridge, QuickChatSnapshot } from "../src/shared/quick-chat.ts";
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
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options }),
    );
  });
};
const mount = async () => {
  await act(async () => root.render(createElement(QuickChat)));
};
const push = async (patch: Partial<QuickChatSnapshot> = {}) => {
  snapshot = { ...snapshot, revision: snapshot.revision + 1, ...patch };
  await act(async () => {
    for (const listener of listeners) listener(snapshot);
  });
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
    setSelection: vi.fn(async () => ok()),
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

test("renders a minimal themed window using only the isolated bridge", async () => {
  await mount();
  expect(document.title).toBe("快速对话 · ZPI");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.style.getPropertyValue("--ui-font-size")).toBe("15px");
  expect(container.textContent).toContain("临时对话，不保存到任务列表");
  expect(container.textContent).not.toContain(snapshot.cwd);
  expect(container.querySelector(".sidebar, .settings-screen, .composer-plus")).toBeNull();
  expect(button("发送").disabled).toBe(true);
  expect(button("新对话").disabled).toBe(false);
  expect(storageWrite).not.toHaveBeenCalled();
});

test("keeps a newer pushed snapshot when the initial request resolves late", async () => {
  const request = deferred<Result<QuickChatSnapshot>>();
  const old = snapshot;
  vi.mocked(bridge.getSnapshot).mockReturnValue(request.promise);
  await mount();
  await push({ selection: { provider: "test", modelId: "second", reasoning: "none" } });
  await act(async () => request.resolve({ ok: true, value: old }));
  expect(button("模型选择").textContent).toContain("Second model");
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
  await click(button("发送"));
  expect(input().value).toBe("");
});

test("retains a failed send and permits retry", async () => {
  vi.mocked(bridge.send).mockResolvedValue({ ok: false, error: { code: "provider", message: "连接失败" } });
  await mount();
  await type("keep this question");
  await click(button("发送"));
  expect(input().value).toBe("keep this question");
  expect(query('[role="alert"]').textContent).toContain("连接失败");
  vi.mocked(bridge.send).mockResolvedValue(ok());
  await click(button("发送"));
  expect(input().value).toBe("");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("does not send while composing, using Shift+Enter, or repeating a held key", async () => {
  await mount();
  await type("中文输入");
  await key(input(), "Enter", { isComposing: true });
  await key(input(), "Enter", { shiftKey: true });
  await key(input(), "Enter", { repeat: true });
  expect(bridge.send).not.toHaveBeenCalled();
  await key(input(), "Enter");
  expect(bridge.send).toHaveBeenCalledExactlyOnceWith("中文输入");
});

test("stops running output while retaining the next draft without persisting reading positions", async () => {
  await mount();
  await push({ session: { ...snapshot.session, runs: [run("running")] } });
  expect(button("模型选择").disabled).toBe(true);
  await type("next question");
  await key(input(), "Enter");
  expect(bridge.send).not.toHaveBeenCalled();
  await click(button("停止"));
  expect(bridge.stop).toHaveBeenCalledOnce();
  expect(input().value).toBe("next question");
  await push({ session: { ...snapshot.session, runs: [run("completed")] } });
  expect(button("发送").disabled).toBe(false);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storageWrite).not.toHaveBeenCalled();
});

test("hides without discarding the draft, then clears it only after a successful new conversation", async () => {
  await mount();
  await type("temporary draft");
  await key(input(), "Escape", { isComposing: true });
  expect(bridge.hide).not.toHaveBeenCalled();
  await key(input(), "Escape");
  expect(bridge.hide).toHaveBeenCalledOnce();
  expect(input().value).toBe("temporary draft");
  vi.mocked(bridge.reset).mockResolvedValue({ ok: false, error: { code: "busy", message: "请重试" } });
  await click(button("新对话"));
  expect(input().value).toBe("temporary draft");
  vi.mocked(bridge.reset).mockResolvedValue(ok());
  await click(button("新对话"));
  expect(input().value).toBe("");
});

test("switches enabled models and lets Escape close the menu before hiding the window", async () => {
  await mount();
  await key(button("模型选择"), "Enter");
  expect(query('[role="menu"]').textContent).not.toContain("Disabled");
  await key(query('[role="menu"]'), "Escape");
  expect(bridge.hide).not.toHaveBeenCalled();
  await key(button("模型选择"), "Enter");
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
    element.textContent?.includes("Second model"),
  );
  expect(option).toBeDefined();
  await click(option as HTMLElement);
  expect(bridge.setSelection).toHaveBeenCalledExactlyOnceWith({
    provider: "test",
    modelId: "second",
    reasoning: "none",
  });
});

test("shows setup guidance and disables sends when no enabled model is available", async () => {
  snapshot = { ...snapshot, selection: null, settings: { ...settings, providers: [] } };
  await mount();
  await type("question");
  expect(button("发送").disabled).toBe(true);
  expect(container.textContent).toContain("请先在主窗口设置中配置模型");
});

test("retries a failed initial load without retaining an obsolete subscription", async () => {
  vi.mocked(bridge.getSnapshot).mockResolvedValueOnce({
    ok: false,
    error: { code: "storage", message: "暂时无法加载" },
  });
  await mount();
  expect(input().disabled).toBe(true);
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
