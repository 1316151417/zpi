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
  unwrap: vi.fn(),
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
    expect(html).toContain('class="settings-row-copy"');
  });

  it("separates recording instructions and global conflicts using secondary hint styling", () => {
    const html = render();
    expect(html).toContain(
      '<div class="settings-hint shortcut-settings-hint"><p>点击快捷键后按下新组合，Esc 取消录入。修改后点击保存。</p><p>全局快捷键可能与其他应用或系统设置冲突；注册失败时会保留原设置。</p></div>',
    );
    expect(html).not.toContain("settings-help");
  });
});
