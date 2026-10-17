import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShortcutSettings } from "../src/renderer/ShortcutSettings.tsx";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  updateShortcuts: vi.fn(),
  setState: vi.fn(),
}));
vi.mock("react", async () => ({
  ...(await vi.importActual("react")),
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.states)) {
      mocks.states[index] = typeof initial === "function" ? initial() : initial;
    }
    return [
      mocks.states[index],
      (value: unknown) => {
        mocks.states[index] = value;
      },
    ];
  },
  useRef: (value: unknown) => ({ current: value }),
  useEffect: vi.fn(),
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: Object.assign(() => undefined, { setState: mocks.setState }),
  report: vi.fn(),
}));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function render() {
  mocks.cursor = 0;
  return elements(ShortcutSettings());
}
function toggle(tree: Element[]) {
  const element = tree.find((element) => element.props.role === "switch");
  expect(element).toBeDefined();
  return element as Element;
}

beforeEach(() => {
  mocks.states = [];
  mocks.updateShortcuts.mockReset();
  mocks.setState.mockReset();
  vi.stubGlobal("window", { zpi: { platform: "darwin", updateShortcuts: mocks.updateShortcuts } });
});
afterEach(() => vi.unstubAllGlobals());

describe("shortcut settings switch state", () => {
  it("changes only the draft until save and persists all bindings unchanged", async () => {
    const initial = defaultShortcuts("darwin");
    const change = toggle(render()).props.onChange as (event: { target: { checked: boolean } }) => void;
    change({ target: { checked: false } });
    expect(mocks.updateShortcuts).not.toHaveBeenCalled();
    const tree = render();
    expect(toggle(tree).props.checked).toBe(false);
    expect(toggle(tree).props["aria-checked"]).toBe(false);
    const save = tree.find((element) => element.props.children === "保存快捷键") as Element;
    expect(save.props.disabled).toBe(false);
    const settings = { shortcuts: { ...initial, enabled: false } };
    mocks.updateShortcuts.mockResolvedValue({ ok: true, value: settings });
    (save.props.onClick as () => void)();
    await vi.waitFor(() => expect(mocks.setState).toHaveBeenCalledWith({ settings }));
    expect(mocks.updateShortcuts).toHaveBeenCalledExactlyOnceWith(settings.shortcuts);
  });

  it.each(["busy", "recording"])("disables the shared switch while %s", (state) => {
    render();
    mocks.states[state === "busy" ? 2 : 1] = state === "busy" ? true : "newTask";
    expect(toggle(render()).props.disabled).toBe(true);
  });
});
