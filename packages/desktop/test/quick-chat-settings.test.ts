import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickChatSettings } from "../src/renderer/QuickChatSettings.tsx";
import type { PublicSettings } from "../src/shared/bridge.ts";
import { defaultCapabilities, defaultPreferences } from "../src/shared/config.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  cursor: 0,
  refCursor: 0,
  settings: undefined as PublicSettings | undefined,
  saveQuickChatSettings: vi.fn(),
  openQuickChat: vi.fn(),
  editShortcut: vi.fn(),
}));
vi.mock("react", async () => ({
  ...(await vi.importActual("react")),
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.states)) mocks.states[index] = initial;
    return [mocks.states[index], (value: unknown) => (mocks.states[index] = value)];
  },
  useRef: (initial: unknown) => {
    const index = mocks.refCursor++;
    mocks.refs[index] ??= { current: initial };
    return mocks.refs[index];
  },
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: Object.assign(
    (select: (state: { settings?: PublicSettings }) => unknown) => select({ settings: mocks.settings }),
    {
      setState: (state: { settings: PublicSettings }) => {
        mocks.settings = state.settings;
      },
    },
  ),
  unwrap: (result: { ok: boolean; error?: { message: string }; value?: unknown }) => {
    if (!result.ok) throw new Error(result.error?.message);
    return result.value;
  },
}));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node)
    return text((node as Element).props.children as ReactNode);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function render() {
  mocks.cursor = 0;
  mocks.refCursor = 0;
  return QuickChatSettings({ onEditShortcut: mocks.editShortcut });
}
function button(label: string) {
  const target = elements(render()).find(
    (element) => element.type === "button" && text(element.props.children as ReactNode) === label,
  );
  expect(target).toBeDefined();
  return target as Element;
}

function select(label: string): Element {
  const target = elements(render()).find((element) => element.props.label === label);
  expect(target).toBeDefined();
  return target as Element;
}
function models() {
  if (!mocks.settings) throw new Error("Missing settings fixture");
  mocks.settings.providers = [
    {
      id: "chat",
      name: "Chat",
      baseUrl: "https://example.com/v1",
      hasApiKey: true,
      models: [
        { id: "first", reasoning: false },
        { id: "second", reasoning: true },
      ],
    },
  ];
  mocks.settings.lastSelection = { provider: "chat", modelId: "second", reasoning: "high" };
  return mocks.settings;
}

beforeEach(() => {
  mocks.states = [];
  mocks.refs = [];
  mocks.settings = {
    shortcuts: defaultShortcuts("darwin"),
    providers: [],
    quickChat: { defaultSelection: null },
    lastSelection: null,
    capabilities: defaultCapabilities,
    interface: defaultPreferences,
    disabledSkillPaths: [],
    credentialsPersisted: false,
    webSearch: {
      provider: "deepseek",
      enabled: false,
      hasApiKey: false,
      apiKeyLength: 0,
      credentialsPersisted: false,
      credentialsLocked: false,
    },
  };
  mocks.saveQuickChatSettings.mockReset();
  mocks.openQuickChat.mockReset();
  mocks.editShortcut.mockReset();
  vi.stubGlobal("window", {
    zpi: {
      platform: "darwin",
      openQuickChat: mocks.openQuickChat,
      saveQuickChatSettings: mocks.saveQuickChatSettings,
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("quick-chat settings", () => {
  it("shows the temporary-session description and current shortcut with an editing link", () => {
    expect(text(render())).toContain("临时对话，不保存到任务列表");
    expect(text(render())).toContain("⌥N");
    expect(button("修改快捷键").props.className).toBe("settings-action-button");
    (button("修改快捷键").props.onClick as () => void)();
    expect(mocks.editShortcut).toHaveBeenCalledOnce();
    expect(mocks.openQuickChat).not.toHaveBeenCalled();
  });

  it("reflects custom, disabled and unbound shortcut settings and displays the no-model setup hint", () => {
    if (!mocks.settings) throw new Error("Missing settings fixture");
    mocks.settings.shortcuts.bindings["quick-chat"] = "Alt+B";
    mocks.settings.shortcuts.enabled = false;
    expect(text(render())).toContain("⌥B（快捷键已停用）");
    expect(button("打开快速对话").props.disabled).toBe(false);
    mocks.settings.shortcuts.bindings["quick-chat"] = null;
    expect(text(render())).toContain("未设置");
    expect(elements(render()).some((element) => ["input", "select"].includes(String(element.type)))).toBe(
      false,
    );
    expect(text(render())).toContain("暂无可用模型");
    expect(select("快速对话默认模型").props.disabled).toBe(true);
    mocks.settings = undefined;
    expect(text(render())).toContain("⌥N");
  });

  it("opens through the bridge once while pending and becomes available after completion", async () => {
    let finish: ((value: unknown) => void) | undefined;
    mocks.openQuickChat.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const click = button("打开快速对话").props.onClick as () => void;
    click();
    click();
    expect(mocks.openQuickChat).toHaveBeenCalledOnce();
    expect(button("打开中…").props.disabled).toBe(true);
    finish?.({ ok: true });
    await vi.waitFor(() => expect(button("打开快速对话").props.disabled).toBe(false));
    expect(elements(render()).some((element) => element.props.role === "alert")).toBe(false);
  });

  it("shows bridge failures and permits another attempt", async () => {
    mocks.openQuickChat.mockResolvedValueOnce({ ok: false, error: { message: "无法创建窗口" } });
    (button("打开快速对话").props.onClick as () => void)();
    await vi.waitFor(() => expect(text(render())).toContain("无法创建窗口"));
    expect(elements(render()).some((element) => element.props.role === "alert")).toBe(true);
    mocks.openQuickChat.mockResolvedValueOnce({ ok: true });
    (button("打开快速对话").props.onClick as () => void)();
    await vi.waitFor(() => expect(button("打开快速对话").props.disabled).toBe(false));
    expect(text(render())).not.toContain("无法创建窗口");
    expect(mocks.openQuickChat).toHaveBeenCalledTimes(2);
  });
});

it("shows deterministic fallback independently of the main task model", () => {
  const settings = models();
  expect(text(render())).toContain("当前自动使用：Chat · first");
  settings.quickChat.defaultSelection = { provider: "chat", modelId: "deleted", reasoning: "high" };
  expect(select("快速对话默认模型").props.value).toBe("unavailable");
  expect(text(render())).toContain("原默认配置已不可用");
  expect(text(render())).toContain("当前自动使用：Chat · first");
  expect(text(render())).toContain("从下一次发送起生效，不会中断当前回复");
});

it("saves a model once while pending and applies only the acknowledged settings", async () => {
  const settings = models();
  let finish!: (value: unknown) => void;
  mocks.saveQuickChatSettings.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const change = select("快速对话默认模型").props.onChange as (value: string) => void;
  change(JSON.stringify(["chat", "second"]));
  change(JSON.stringify(["chat", "first"]));
  expect(mocks.saveQuickChatSettings).toHaveBeenCalledOnce();
  const input = mocks.saveQuickChatSettings.mock.calls[0][0];
  expect(input).toEqual({ defaultSelection: { provider: "chat", modelId: "second", reasoning: "medium" } });
  expect(select("快速对话默认模型").props.value).toBe("auto");
  expect(select("快速对话默认模型").props.disabled).toBe(true);
  expect(button("修改快捷键").props.disabled).toBe(true);
  finish({ ok: true, value: { ...settings, quickChat: input } });
  await vi.waitFor(() => expect(select("快速对话默认模型").props.disabled).toBe(false));
  expect(select("快速对话默认模型").props.value).toBe(JSON.stringify(["chat", "second"]));
  expect(select("快速对话思考级别").props.value).toBe("medium");
  expect(mocks.settings?.lastSelection).toEqual(settings.lastSelection);
});

it("retains the prior model on save failure and permits a retry", async () => {
  const settings = models();
  settings.quickChat.defaultSelection = { provider: "chat", modelId: "first", reasoning: "none" };
  mocks.saveQuickChatSettings.mockResolvedValueOnce({ ok: false, error: { message: "disk full" } });
  (select("快速对话默认模型").props.onChange as (value: string) => void)(JSON.stringify(["chat", "second"]));
  await vi.waitFor(() => expect(text(render())).toContain("默认模型保存失败"));
  expect(select("快速对话默认模型").props.value).toBe(JSON.stringify(["chat", "first"]));
  expect(select("快速对话默认模型").props.disabled).toBe(false);
  mocks.saveQuickChatSettings.mockResolvedValueOnce({
    ok: true,
    value: { ...settings, quickChat: { defaultSelection: null } },
  });
  (select("快速对话默认模型").props.onChange as (value: string) => void)("auto");
  await vi.waitFor(() => expect(select("快速对话默认模型").props.value).toBe("auto"));
  expect(text(render())).not.toContain("默认模型保存失败");
});
