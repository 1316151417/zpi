import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserPane } from "../src/renderer/BrowserPane.tsx";
import type { BrowserState } from "../src/shared/bridge.ts";

function render(state: Partial<BrowserState> = {}) {
  return renderToStaticMarkup(
    createElement(BrowserPane, {
      state: {
        id: "browser-test",
        url: "",
        title: "浏览器",
        loading: false,
        back: false,
        forward: false,
        ...state,
      },
      visible: true,
    }),
  );
}

function buttons(html: string) {
  return html.match(/<button\b[^>]*>/g) ?? [];
}

describe("browser toolbar presentation", () => {
  it("keeps the blank canvas quiet and only the four requested controls", () => {
    const html = render();
    expect(buttons(html)).toHaveLength(4);
    expect(buttons(html).every((button) => button.includes('disabled=""'))).toBe(true);
    expect(html).toContain('placeholder="输入"');
    expect(html).toContain('aria-label="浏览器地址"');
    expect(html).toContain('spellCheck="false"');
    expect(html).not.toContain("输入地址，或点击聊天中的链接");
    expect(html).not.toContain("pane-empty");
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("lucide-chevron-left");
    expect(html).toContain("lucide-chevron-right");
    expect(html).toContain("lucide-refresh-cw");
    expect(html).toContain("lucide-external-link");
    expect(html.match(/width="16" height="16"/g)).toHaveLength(4);
  });

  it("preserves full URL text, history availability and the default-browser action", () => {
    const url = "https://example.test/a?q=test#part";
    const html = render({ url, back: true, forward: false });
    expect(html).toContain(`value="${url}"`);
    expect(buttons(html)[0]).not.toContain("disabled");
    expect(buttons(html)[1]).toContain("disabled");
    expect(buttons(html)[2]).not.toContain("disabled");
    expect(buttons(html)[3]).toContain('aria-label="在外部浏览器打开"');
    expect(buttons(html)[3]).not.toContain("disabled");
  });

  it("retains stop while loading and displays load failures without empty-state clutter", () => {
    const loading = render({ url: "http://localhost:3000/", loading: true, forward: true });
    expect(loading).toContain('aria-label="停止加载"');
    expect(loading).toContain("lucide-x");
    expect(loading).not.toContain("lucide-refresh-cw");
    expect(buttons(loading)[1]).not.toContain("disabled");
    const failed = render({ url: "http://localhost:3000/", error: "页面加载失败" });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("页面加载失败");
    expect(failed).toContain('aria-label="刷新页面"');
  });

  it("keeps local file addresses intact", () => {
    expect(render({ url: "file:///tmp/preview%20page.html" })).toContain(
      'value="file:///tmp/preview%20page.html"',
    );
  });
});
