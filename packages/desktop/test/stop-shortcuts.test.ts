import type { ComponentProps, ReactElement, KeyboardEvent as ReactKeyboardEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MentionEditor } from "../../ui/src/components/MentionEditor.tsx";
import { useStopOnEscape } from "../src/renderer/use-stop-on-escape.ts";
import { defaultShortcuts, type ShortcutSettings, validateShortcuts } from "../src/shared/shortcuts.ts";

const mocks = vi.hoisted(() => ({
  effects: [] as (() => undefined | (() => void))[],
  settings: undefined as ShortcutSettings | undefined,
}));
vi.mock("react", async () => ({
  ...(await vi.importActual("react")),
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: (effect: () => undefined | (() => void)) => mocks.effects.push(effect),
  useLayoutEffect: vi.fn(),
  useImperativeHandle: vi.fn(),
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: { getState: () => ({ settings: { shortcuts: mocks.settings } }) },
}));

type Key = KeyboardEvent & { nativeEvent: KeyboardEvent };
function key(overrides: Partial<KeyboardEvent> = {}): Key {
  const event = new Event("keydown", { cancelable: true, bubbles: true });
  Object.assign(event, {
    key: "Enter",
    code: "Enter",
    metaKey: true,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 13,
    ...overrides,
    nativeEvent: event,
  });
  return event as Key;
}

const listeners = new Map<string, (event: Event) => void>();
const querySelector = vi.fn(() => null as unknown);
let activeElement: object;
let cleanup: undefined | (() => void);
function start(stop = vi.fn()) {
  // biome-ignore lint/correctness/useHookAtTopLevel: React hooks are mocked to expose the actual event handlers without a DOM renderer.
  useStopOnEscape(stop);
  cleanup = mocks.effects[0]?.();
  return stop;
}
function dispatch(event: Key, target?: (event: Key) => void) {
  listeners.get("keydown:true")?.(event);
  if (!event.cancelBubble) target?.(event);
  if (!event.cancelBubble) listeners.get("keydown:false")?.(event);
}

describe("stop shortcut event routing", () => {
  beforeEach(() => {
    mocks.effects.length = 0;
    listeners.clear();
    querySelector.mockReturnValue(null);
    mocks.settings = defaultShortcuts("darwin");
    mocks.settings.bindings["stop-run"] = "Shift+Command+Enter";
    activeElement = { conversation: "main" };
    vi.stubGlobal("window", { zpi: { platform: "darwin" }, getSelection: () => null });
    vi.stubGlobal("document", {
      querySelector,
      querySelectorAll: () => (querySelector() ? [{ closest: () => null, getClientRects: () => [{}] }] : []),
      get activeElement() {
        return activeElement;
      },
      addEventListener: (name: string, listener: (event: Event) => void, capture = false) =>
        listeners.set(`${name}:${capture}`, listener),
      removeEventListener: (name: string, _listener: unknown, capture = false) =>
        listeners.delete(`${name}:${capture}`),
    });
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllGlobals();
  });

  it.each(["darwin", "linux"])(
    "consumes a valid custom stop key before the real editor inserts a newline on %s",
    (platform) => {
      vi.stubGlobal("window", { zpi: { platform }, getSelection: () => null });
      mocks.settings = defaultShortcuts(platform);
      mocks.settings.bindings["stop-run"] =
        platform === "darwin" ? "Shift+Command+Enter" : "Control+Shift+Enter";
      expect(validateShortcuts(mocks.settings, platform)).toBeUndefined();
      const stop = start();
      class Element {
        dataset = {};
        childNodes = [{ nodeType: 3, textContent: "draft" }];
        getAnimations() {
          return [];
        }
      }
      vi.stubGlobal("HTMLElement", Element);
      vi.stubGlobal("HTMLBRElement", class {});
      vi.stubGlobal("HTMLDivElement", class {});
      vi.stubGlobal("Node", { TEXT_NODE: 3 });
      const change = vi.fn();
      const render = Reflect.get(MentionEditor, "render") as (
        props: ComponentProps<typeof MentionEditor>,
        ref: null,
      ) => ReactElement<{
        ref: { current: unknown };
        onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
      }>;
      const editor = render(
        {
          value: "draft",
          onChange: change,
          onKeyDown: vi.fn(),
          onPaste: vi.fn(),
          onCompositionStart: vi.fn(),
          onCompositionEnd: vi.fn(),
        },
        null,
      );
      editor.props.ref.current = new Element();
      const event = key({ metaKey: platform === "darwin", ctrlKey: platform !== "darwin" });
      dispatch(event, (event) =>
        editor.props.onKeyDown(event as unknown as ReactKeyboardEvent<HTMLDivElement>),
      );
      expect(stop).toHaveBeenCalledOnce();
      expect(change).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
      expect(event.cancelBubble).toBe(true);
    },
  );

  it("consumes held custom keys without repeated dispatch or target input", () => {
    const stop = start();
    const target = vi.fn();
    dispatch(key(), target);
    const repeat = key({ repeat: true });
    dispatch(repeat, target);
    expect(stop).toHaveBeenCalledOnce();
    expect(target).not.toHaveBeenCalled();
    expect(repeat.defaultPrevented).toBe(true);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("leaves IME input untouched: %j", (flags) => {
    const stop = start();
    const event = key(flags);
    dispatch(event);
    expect(stop).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("tracks composition across events, including events without IME flags", () => {
    const stop = start();
    listeners.get("compositionstart:true")?.(new Event("compositionstart"));
    dispatch(key());
    expect(stop).not.toHaveBeenCalled();
    listeners.get("compositionend:true")?.(new Event("compositionend"));
    dispatch(key());
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not dispatch through overlays, consumed input, disabled or unbound settings", () => {
    const stop = start();
    querySelector.mockReturnValue({});
    dispatch(key());
    querySelector.mockReturnValue(null);
    const consumed = key();
    consumed.preventDefault();
    dispatch(consumed);
    if (!mocks.settings) throw Error("Missing settings");
    mocks.settings.enabled = false;
    dispatch(key());
    mocks.settings.enabled = true;
    mocks.settings.bindings["stop-run"] = null;
    dispatch(key());
    expect(stop).not.toHaveBeenCalled();
  });

  it("preserves bare Escape dismissal precedence and the captured overlay snapshot", () => {
    if (!mocks.settings) throw Error("Missing settings");
    mocks.settings.bindings["stop-run"] = "Escape";
    const stop = start();
    const escapeKey = (repeat = false) =>
      key({ key: "Escape", code: "Escape", metaKey: false, shiftKey: false, repeat });
    dispatch(escapeKey(), (event) => event.preventDefault());
    querySelector.mockReturnValue({});
    dispatch(escapeKey(), () => querySelector.mockReturnValue(null));
    dispatch(escapeKey(true));
    expect(stop).not.toHaveBeenCalled();
    dispatch(escapeKey());
    expect(stop).toHaveBeenCalledOnce();
  });

  it("calls the existing stop callback with the main or side conversation focus unchanged", () => {
    const seen: (Element | null)[] = [];
    start(vi.fn(() => seen.push(document.activeElement)));
    const main = activeElement;
    dispatch(key());
    const side = { conversation: "side" };
    activeElement = side;
    dispatch(key());
    expect(seen).toEqual([main, side]);
    expect(document.activeElement).toBe(side);
  });
});
