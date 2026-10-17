import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickChatSettings } from "../src/renderer/QuickChatSettings.tsx";
import { defaultShortcuts, type ShortcutSettings } from "../src/shared/shortcuts.ts";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  cursor: 0,
  refCursor: 0,
  shortcuts: undefined as ShortcutSettings | undefined,
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
  useStore: () => mocks.shortcuts,
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

beforeEach(() => {
  mocks.states = [];
  mocks.refs = [];
  mocks.shortcuts = defaultShortcuts("darwin");
  mocks.openQuickChat.mockReset();
  mocks.editShortcut.mockReset();
  vi.stubGlobal("window", { zpi: { platform: "darwin", openQuickChat: mocks.openQuickChat } });
});
afterEach(() => vi.unstubAllGlobals());

describe("quick-chat settings", () => {
  it("shows the temporary-session description and current shortcut with an editing link", () => {
    expect(text(render())).toContain("临时对话，不保存到任务列表");
    expect(text(render())).toContain("⌥N");
    (button("修改快捷键").props.onClick as () => void)();
    expect(mocks.editShortcut).toHaveBeenCalledOnce();
    expect(mocks.openQuickChat).not.toHaveBeenCalled();
  });

  it("reflects custom, disabled and unbound shortcut settings without adding other preferences", () => {
    if (!mocks.shortcuts) throw new Error("Missing settings fixture");
    mocks.shortcuts.bindings["quick-chat"] = "Alt+B";
    mocks.shortcuts.enabled = false;
    expect(text(render())).toContain("⌥B（快捷键已停用）");
    expect(button("打开快速对话").props.disabled).toBe(false);
    mocks.shortcuts.bindings["quick-chat"] = null;
    expect(text(render())).toContain("未设置");
    expect(elements(render()).some((element) => ["input", "select"].includes(String(element.type)))).toBe(
      false,
    );
    mocks.shortcuts = undefined;
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
