import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserPane } from "../src/renderer/BrowserPane.tsx";
import type { BrowserState } from "../src/shared/bridge.ts";

vi.mock("react", async () => ({
  ...(await vi.importActual("react")),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: vi.fn(),
}));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function render(state: Partial<BrowserState> = {}) {
  return elements(
    BrowserPane({
      state: {
        id: "browser-test",
        url: "https://example.test/",
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
function refresh(state: Partial<BrowserState>) {
  const button = render(state).find((element) => element.props["aria-label"] === "刷新页面");
  expect(button).toBeDefined();
  return button as Element;
}

afterEach(() => vi.unstubAllGlobals());

describe("browser refresh action", () => {
  it.each([false, true])("reloads rather than stops when loading is %s", (loading) => {
    const browserAction = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    vi.stubGlobal("window", { zpi: { browserAction } });
    const button = refresh({ loading });
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    (button.props.onClick as () => void)();
    expect(browserAction.mock.calls).toEqual([
      ["browser-test", "reload"],
      ["browser-test", "reload"],
    ]);
    const icon = button.props.children as Element;
    expect(icon.props.className).toBe(loading ? "browser-refresh-spinning" : undefined);
  });

  it("preserves availability for blank, loading, loaded and failed pages", () => {
    expect(refresh({ url: "", loading: false }).props.disabled).toBe(true);
    expect(refresh({ url: "", loading: true }).props.disabled).toBe(false);
    expect(refresh({ loading: false }).props.disabled).toBe(false);
    expect(refresh({ error: "页面加载失败" }).props.disabled).toBe(false);
  });

  it("exposes the reference placeholder on the editable address input", () => {
    const input = render().find((element) => element.type === "input");
    expect(input?.props.placeholder).toBe("输入网址后回车");
    expect(input?.props["aria-label"]).toBe("浏览器地址");
  });
});
