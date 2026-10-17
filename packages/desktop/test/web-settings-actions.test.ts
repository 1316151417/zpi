import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSearchSettings } from "../src/renderer/WebSearchSettings.tsx";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  webSearch: {
    provider: "deepseek",
    enabled: false,
    hasApiKey: false,
    credentialsPersisted: false,
    credentialsLocked: false,
  },
  saveWebSearch: vi.fn(),
  setState: vi.fn(),
}));
vi.mock("react", async () => ({
  ...(await vi.importActual("react")),
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.states)) mocks.states[index] = initial;
    return [
      mocks.states[index],
      (value: unknown) => {
        mocks.states[index] = typeof value === "function" ? value(mocks.states[index]) : value;
      },
    ];
  },
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ settings: { webSearch: mocks.webSearch, capabilities: { webSearch: true } } }),
    { setState: mocks.setState },
  ),
  unwrap: (result: { value: unknown }) => result.value,
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
  return elements(WebSearchSettings());
}
function find(predicate: (element: Element) => boolean) {
  const element = render().find(predicate);
  expect(element).toBeDefined();
  return element as Element;
}
function button(label: string) {
  return find((element) => element.type === "button" && element.props.children === label);
}
function click(label: string) {
  const target = button(label);
  expect(target.props.disabled).toBeFalsy();
  (target.props.onClick as () => void)();
}
function draft(value: string) {
  const input = find((element) => element.props.id === "web-search-api-key");
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
function submit() {
  const form = find((element) => element.type === "form");
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
}
async function saved() {
  await vi.waitFor(() => expect(mocks.setState).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  mocks.states = [];
  mocks.webSearch = {
    provider: "deepseek",
    enabled: false,
    hasApiKey: false,
    credentialsPersisted: false,
    credentialsLocked: false,
  };
  mocks.saveWebSearch.mockReset().mockResolvedValue({ ok: true, value: { webSearch: mocks.webSearch } });
  mocks.setState.mockReset();
  vi.stubGlobal("window", { zpi: { saveWebSearch: mocks.saveWebSearch } });
});
afterEach(() => vi.unstubAllGlobals());

test("saving a credential sends no provider or global enable change", async () => {
  draft("  fake-draft-key  ");
  submit();
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({
    provider: "deepseek",
    apiKey: "fake-draft-key",
  });
  expect(find((element) => element.props.id === "web-search-api-key").props.value).toBe("");
});

test("enabling with a draft saves the key and enables the provider in one request", async () => {
  expect(button("启用").props.disabled).toBe(true);
  draft("fake-enable-key");
  click("启用");
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({
    provider: "deepseek",
    apiKey: "fake-enable-key",
    enabled: true,
  });
});

test("enabling an existing credential never fetches or resends its raw value", async () => {
  mocks.webSearch.hasApiKey = true;
  click("启用");
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({ provider: "deepseek", enabled: true });
});

test("disabling preserves an unsaved draft and does not replace saved credentials", async () => {
  mocks.webSearch.enabled = true;
  mocks.webSearch.hasApiKey = true;
  draft("unsaved-fake-key");
  click("停用");
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({ provider: "deepseek", enabled: false });
  expect(find((element) => element.props.id === "web-search-api-key").props.value).toBe("unsaved-fake-key");
});

test("key removal requires confirmation, cancellation leaves it intact, and confirmed removal is explicit", async () => {
  mocks.webSearch.hasApiKey = true;
  click("移除 API Key");
  expect(mocks.saveWebSearch).not.toHaveBeenCalled();
  click("取消");
  expect(mocks.saveWebSearch).not.toHaveBeenCalled();
  click("移除 API Key");
  click("确认移除");
  await saved();
  expect(mocks.saveWebSearch).toHaveBeenCalledExactlyOnceWith({ provider: "deepseek", apiKey: "" });
});

test("pending writes disable controls and failed writes keep the draft without exposing it in errors", async () => {
  let reject: (error: Error) => void = () => undefined;
  mocks.saveWebSearch.mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  draft("private-fake-key");
  click("启用");
  expect(button("启用").props.disabled).toBe(true);
  expect(find((element) => element.props.id === "web-search-api-key").props.disabled).toBe(true);
  reject(new Error("cannot save private-fake-key"));
  await vi.waitFor(() => expect(button("启用").props.disabled).toBe(false));
  expect(find((element) => element.props.role === "alert").props.children).toBe(
    "Error: cannot save [已隐藏]",
  );
  expect(find((element) => element.props.id === "web-search-api-key").props.value).toBe("private-fake-key");
  expect(mocks.setState).not.toHaveBeenCalled();
});
