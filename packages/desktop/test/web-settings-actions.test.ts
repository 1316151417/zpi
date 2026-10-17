import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSearchSettings } from "../src/renderer/WebSearchSettings.tsx";
import type { PublicSettings, WebSearchSettingsInput } from "../src/shared/bridge.ts";

const mask = "********";
const mocks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  webSearch: {
    provider: "deepseek",
    enabled: false,
    hasApiKey: false,
    credentialsPersisted: false,
    credentialsLocked: false,
  } as PublicSettings["webSearch"],
  saveWebSearch: vi.fn(),
  getProviderCredentials: vi.fn(),
  blurInput: vi.fn(),
  setState: vi.fn(),
}));
vi.mock("react", async () => ({
  ...(await vi.importActual("react")),
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.states)) mocks.states[index] = typeof initial === "function" ? initial() : initial;
    return [
      mocks.states[index],
      (value: unknown) => {
        mocks.states[index] = typeof value === "function" ? value(mocks.states[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.states)) mocks.states[index] = { current: initial };
    return mocks.states[index];
  },
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ settings: { webSearch: mocks.webSearch, capabilities: { webSearch: true } } }),
    { setState: mocks.setState },
  ),
  unwrap: (result: { ok: boolean; value?: unknown; error?: { code: string; message: string } }) => {
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
function render() {
  mocks.cursor = 0;
  const tree = elements(WebSearchSettings());
  const field = tree.find((element) => element.props.id === "web-search-api-key");
  const ref = field?.props.ref as { current: unknown } | undefined;
  if (ref) ref.current = { blur: mocks.blurInput };
  return tree;
}
function find(predicate: (element: Element) => boolean) {
  const element = render().find(predicate);
  expect(element).toBeDefined();
  return element as Element;
}
function button(label: string) {
  return find((element) => element.type === "button" && element.props.children === label);
}
function input() {
  return find((element) => element.props.id === "web-search-api-key");
}
function visibility() {
  return find(
    (element) =>
      element.type === "button" && /^(显示|隐藏) API Key$/.test(String(element.props["aria-label"])),
  );
}
function click(label: string) {
  const target = button(label);
  expect(target.props.disabled).toBeFalsy();
  (target.props.onClick as () => void)();
}
function focus() {
  expect(input().props.disabled).toBeFalsy();
  (input().props.onFocus as () => void)();
}
function blur() {
  (input().props.onBlur as () => void)();
}
function pressEscape() {
  const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
  (input().props.onKeyDown as (keyEvent: typeof event) => void)(event);
}
function draft(value: string) {
  (input().props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
function submit() {
  const form = find((element) => element.type === "form");
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
}
function toggleVisibility() {
  const target = visibility();
  expect(target.props.disabled).toBeFalsy();
  (target.props.onClick as () => void)();
}
async function saved(count = 1) {
  await vi.waitFor(() => expect(mocks.setState).toHaveBeenCalledTimes(count));
}
function stored() {
  mocks.webSearch.hasApiKey = true;
  mocks.webSearch.credentialsPersisted = true;
}
function expectMask() {
  expect(input().props.value).toBe(mask);
  expect(input().props.type).toBe("text");
  expect(visibility().props.disabled).toBe(true);
  expect(visibility().props["aria-pressed"]).toBe(false);
}
function holdSave() {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  mocks.saveWebSearch.mockReturnValue(
    new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    }),
  );
  return {
    resolve: () => resolve({ ok: true, value: { webSearch: { ...mocks.webSearch } } }),
    reject,
  };
}

beforeEach(() => {
  mocks.states = [];
  mocks.blurInput.mockReset();
  mocks.webSearch = {
    provider: "deepseek",
    enabled: false,
    hasApiKey: false,
    credentialsPersisted: false,
    credentialsLocked: false,
  };
  mocks.saveWebSearch.mockReset().mockImplementation(async (change: WebSearchSettingsInput) => ({
    ok: true,
    value: {
      webSearch: {
        ...mocks.webSearch,
        ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
        ...(change.apiKey !== undefined ? { hasApiKey: Boolean(change.apiKey) } : {}),
      },
    },
  }));
  mocks.getProviderCredentials.mockReset().mockImplementation(() => {
    throw new Error("The web settings must never fetch a raw stored credential");
  });
  mocks.setState
    .mockReset()
    .mockImplementation((state: { settings: { webSearch: PublicSettings["webSearch"] } }) => {
      mocks.webSearch = state.settings.webSearch;
    });
  vi.stubGlobal("window", {
    zpi: { saveWebSearch: mocks.saveWebSearch, getProviderCredentials: mocks.getProviderCredentials },
  });
});
afterEach(() => {
  expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

// These tests dispatch component handlers with persistent hook state; they do not launch a browser.
test("saving a new credential sends a trimmed key without changing either enable state", async () => {
  focus();
  draft("  fake-draft-key  ");
  submit();
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({
    provider: "deepseek",
    apiKey: "fake-draft-key",
  });
  expectMask();
});

test("a saved credential starts as a fixed mask and focus creates an empty replacement draft", () => {
  stored();
  expectMask();
  focus();
  expect(input().props.value).toBe("");
  expect(input().props.type).toBe("password");
  expect(button("保存").props.disabled).toBe(true);
  expect(mocks.saveWebSearch).not.toHaveBeenCalled();
  blur();
  expectMask();
  focus();
  expect(input().props.value).toBe("");
  expect(mocks.saveWebSearch).not.toHaveBeenCalled();
});

test.each(["", "   "])("an empty or whitespace replacement (%j) restores the mask on blur", (value) => {
  stored();
  focus();
  draft(value);
  blur();
  expectMask();
  submit();
  expect(mocks.saveWebSearch).not.toHaveBeenCalled();
});

test.each(["Escape", "cancel"])(
  "%s discards an edited replacement without sending a credential",
  (action) => {
    stored();
    focus();
    draft("fake-discarded-key");
    toggleVisibility();
    if (action === "Escape") pressEscape();
    else click("取消编辑");
    expectMask();
    submit();
    expect(mocks.saveWebSearch).not.toHaveBeenCalled();
    focus();
    expect(input().props.value).toBe("");
    expect(input().props.type).toBe("password");
  },
);

test("Escape blurs the replacement, ignores changes to the restored mask, and requires a fresh focus", async () => {
  stored();
  focus();
  draft("fake-before-escape");
  pressEscape();
  expect(mocks.blurInput).toHaveBeenCalledOnce();
  expectMask();
  draft(`${mask}accidental-typing`);
  expectMask();
  submit();
  expect(mocks.saveWebSearch).not.toHaveBeenCalled();
  focus();
  expect(input().props.value).toBe("");
  draft("fake-after-refocus");
  submit();
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({
    provider: "deepseek",
    apiKey: "fake-after-refocus",
  });
  expect(mocks.blurInput).toHaveBeenCalledTimes(2);
  expectMask();
});

test("blur and refocus retain a nonempty replacement, and visibility reveals only that draft", () => {
  stored();
  expectMask();
  focus();
  draft("fake-visible-draft");
  expect(input().props.type).toBe("password");
  toggleVisibility();
  expect(input().props.type).toBe("text");
  expect(input().props.value).toBe("fake-visible-draft");
  expect(visibility().props["aria-label"]).toBe("隐藏 API Key");
  expect(visibility().props["aria-pressed"]).toBe(true);
  blur();
  focus();
  expect(input().props.value).toBe("fake-visible-draft");
  toggleVisibility();
  expect(input().props.type).toBe("password");
  click("取消编辑");
  expectMask();
  expect(mocks.saveWebSearch).not.toHaveBeenCalled();
});

test("replacing an existing key sends only the entered key and returns to the fixed mask", async () => {
  stored();
  focus();
  draft("  fake-replacement-key  ");
  blur();
  submit();
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({
    provider: "deepseek",
    apiKey: "fake-replacement-key",
  });
  expect(mocks.blurInput).toHaveBeenCalledOnce();
  expectMask();
});

test("enabling with a draft saves the key and enables the provider in one request", async () => {
  expect(button("启用").props.disabled).toBe(true);
  focus();
  draft(" fake-enable-key ");
  click("启用");
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({
    provider: "deepseek",
    apiKey: "fake-enable-key",
    enabled: true,
  });
  expectMask();
});

test.each(["masked", "empty edit", "cleared edit", "cancelled edit"])(
  "enabling a stored credential from %s omits apiKey completely",
  async (state) => {
    stored();
    if (state !== "masked") focus();
    if (state === "cleared edit") {
      draft("fake-cleared-key");
      draft("");
      blur();
    }
    if (state === "cancelled edit") {
      draft("fake-cancelled-key");
      click("取消编辑");
    }
    submit();
    expect(mocks.saveWebSearch).not.toHaveBeenCalled();
    click("启用");
    await saved();
    expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({ provider: "deepseek", enabled: true });
    expectMask();
  },
);

test.each(["*", mask, "  ************  ", "••••••••", "●●●●", "*•●**"])(
  "mask-only text %j is never a replacement credential",
  async (value) => {
    focus();
    draft(value);
    expect(button("保存").props.disabled).toBe(true);
    expect(button("启用").props.disabled).toBe(true);
    submit();
    expect(mocks.saveWebSearch).not.toHaveBeenCalled();
    stored();
    click("启用");
    await saved();
    expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({ provider: "deepseek", enabled: true });
    expectMask();
  },
);

test("disabling a saved credential omits apiKey even when an unsaved replacement exists", async () => {
  stored();
  mocks.webSearch.enabled = true;
  focus();
  draft("unsaved-fake-key");
  click("停用");
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({ provider: "deepseek", enabled: false });
  expect(input().props.value).toBe("unsaved-fake-key");
  click("取消编辑");
  expectMask();
});

test("key removal requires confirmation, cancellation preserves the key, and removal is explicit", async () => {
  stored();
  click("移除 API Key");
  expect(mocks.saveWebSearch).not.toHaveBeenCalled();
  expect(input().props.disabled).toBe(true);
  expect(button("启用").props.disabled).toBe(true);
  click("取消");
  expectMask();
  expect(mocks.saveWebSearch).not.toHaveBeenCalled();
  click("移除 API Key");
  click("确认移除");
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({ provider: "deepseek", apiKey: "" });
  expect(input().props.value).toBe("");
  expect(button("启用").props.disabled).toBe(true);
});

test("confirming removal clears a replacement draft and never sends that draft", async () => {
  stored();
  focus();
  draft("fake-draft-before-removal");
  click("移除 API Key");
  click("确认移除");
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({ provider: "deepseek", apiKey: "" });
  expect(input().props.value).toBe("");
  submit();
  expect(mocks.saveWebSearch).toHaveBeenCalledTimes(1);
});

test.each(["save", "enable", "disable", "remove"])(
  "%s blocks same-render repeated handlers and locks all controls until the request resolves",
  async (action) => {
    stored();
    if (action === "disable") mocks.webSearch.enabled = true;
    if (action === "save" || action === "enable") {
      focus();
      draft("fake-pending-key");
    }
    if (action === "remove") click("移除 API Key");
    const pending = holdSave();
    const target =
      action === "save"
        ? find((element) => element.type === "form")
        : button(action === "enable" ? "启用" : action === "disable" ? "停用" : "确认移除");
    const handler = (action === "save" ? target.props.onSubmit : target.props.onClick) as (event: {
      preventDefault: () => void;
    }) => void;
    handler({ preventDefault: vi.fn() });
    handler({ preventDefault: vi.fn() });
    submit();
    expect(mocks.saveWebSearch).toHaveBeenCalledTimes(1);
    for (const control of render().filter((element) => ["input", "button"].includes(String(element.type)))) {
      expect(control.props.disabled).toBe(true);
    }
    pending.resolve();
    await saved();
    expect(mocks.saveWebSearch).toHaveBeenCalledTimes(1);
    expect(input().props.disabled).toBeFalsy();
  },
);

test("failed writes retain and redact the replacement, unlock controls, and allow an explicit retry", async () => {
  stored();
  focus();
  draft("  private-fake-key  ");
  const pending = holdSave();
  submit();
  pending.reject(new Error("cannot save private-fake-key; private-fake-key was rejected"));
  await vi.waitFor(() => expect(button("保存").props.disabled).toBe(false));
  expect(find((element) => element.props.role === "alert").props.children).toBe(
    "Error: cannot save [已隐藏]; [已隐藏] was rejected",
  );
  expect(input().props.value).toBe("  private-fake-key  ");
  expect(mocks.setState).not.toHaveBeenCalled();
  mocks.saveWebSearch.mockResolvedValue({ ok: true, value: { webSearch: { ...mocks.webSearch } } });
  submit();
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledTimes(2);
  expect(mocks.saveWebSearch).toHaveBeenLastCalledWith({ provider: "deepseek", apiKey: "private-fake-key" });
  expectMask();
  expect(render().some((element) => element.props.role === "alert")).toBe(false);
});

test("failed removal preserves the stored mask and remains cancellable", async () => {
  stored();
  mocks.saveWebSearch.mockResolvedValue({
    ok: false,
    error: { code: "STORAGE_ERROR", message: "Storage unavailable" },
  });
  click("移除 API Key");
  click("确认移除");
  await vi.waitFor(() => expect(button("确认移除").props.disabled).toBe(false));
  expect(mocks.setState).not.toHaveBeenCalled();
  expect(input().props.value).toBe(mask);
  click("取消");
  expectMask();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({ provider: "deepseek", apiKey: "" });
});

test("locked credentials stay masked and cannot be edited, removed, or enabled, but can be disabled", async () => {
  stored();
  mocks.webSearch.credentialsLocked = true;
  expectMask();
  expect(input().props.disabled).toBe(true);
  expect(button("保存").props.disabled).toBe(true);
  expect(button("启用").props.disabled).toBe(true);
  expect(button("移除 API Key").props.disabled).toBe(true);
  submit();
  expect(mocks.saveWebSearch).not.toHaveBeenCalled();
  mocks.webSearch.enabled = true;
  click("停用");
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({ provider: "deepseek", enabled: false });
  expectMask();
});
