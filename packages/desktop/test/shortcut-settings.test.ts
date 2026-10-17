import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutSettings } from "../src/renderer/ShortcutSettings.tsx";
import { defaultShortcuts, type ShortcutSettings as ShortcutPreferences } from "../src/shared/shortcuts.ts";

const mocks = vi.hoisted(() => ({
  settings: undefined as { shortcuts: ShortcutPreferences } | undefined,
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: (select: (state: typeof mocks) => unknown) => select(mocks),
  report: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

function render(enabled = true) {
  vi.stubGlobal("window", { zpi: { platform: "darwin" } });
  mocks.settings = { shortcuts: { ...defaultShortcuts("darwin"), enabled } };
  return renderToStaticMarkup(createElement(ShortcutSettings));
}

describe("shortcut settings presentation", () => {
  it.each([true, false])("uses the existing settings switch with enabled=%s", (enabled) => {
    const html = render(enabled);
    expect(html).toContain('<span class="settings-switch"><input type="checkbox" role="switch"');
    expect(html).toContain(`aria-label="启用快捷键" aria-checked="${enabled}"`);
    expect(html).toContain('<span aria-hidden="true"></span></span></label>');
    expect(html).toContain('class="shortcut-enable"');
  });

  it("presents four columns with real scopes, compact keys and accessible actions", () => {
    const html = render();
    for (const label of [
      "命令",
      "按键绑定",
      "作用域",
      "操作",
      "系统全局",
      "输入框",
      "新任务输入框",
      "任务面板",
    ])
      expect(html).toContain(label);
    expect(html).toContain('aria-label="按组合键搜索"');
    expect(html).toContain('aria-label="编辑选择模型快捷键"');
    expect(html).toContain('aria-label="清除选择模型快捷键"');
    expect(html).toContain("<kbd>⌘</kbd><kbd>L</kbd>");
    expect(html).toContain("全部恢复默认");
    expect(html).toContain('data-shortcut-command="quick-chat"');
    expect(html).toContain("<kbd>⌥</kbd><kbd>N</kbd>");
    expect(html).toContain('aria-label="编辑快速对话快捷键"');
    expect(html).toContain('data-shortcut-command="quick-chat-new"');
    expect(html).toContain("<kbd>⌥</kbd><kbd>⇧</kbd><kbd>N</kbd>");
    expect(html).toContain('aria-label="编辑新建快速对话快捷键"');
    expect(html).toContain('aria-label="清除新建快速对话快捷键"');
  });
});
