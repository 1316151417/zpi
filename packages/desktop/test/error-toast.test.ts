import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ErrorToast } from "../src/renderer/ErrorToast.tsx";

let root: Root;
let container: HTMLDivElement;
const dismiss = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  dismiss.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mount = (key = 1) =>
  act(async () => root.render(createElement(ErrorToast, { key, message: "文件不存在", onDismiss: dismiss })));
const advance = (time: number) => act(async () => vi.advanceTimersByTime(time));

test("announces a dismissible error without stealing focus and expires after five seconds", async () => {
  const previousFocus = document.activeElement;
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("文件不存在");
  expect(document.activeElement).toBe(previousFocus);
  await advance(4999);
  expect(dismiss).not.toHaveBeenCalled();
  await advance(1);
  expect(dismiss).toHaveBeenCalledOnce();
});

test.each(["hover", "focus"])("keeps the toast available while the user reads it with %s", async (kind) => {
  await mount();
  const toast = container.querySelector<HTMLElement>('[role="alert"]');
  const close = container.querySelector<HTMLButtonElement>("button");
  await act(async () => {
    if (kind === "hover") toast?.dispatchEvent(new Event("pointerover", { bubbles: true }));
    else close?.focus();
  });
  await advance(8000);
  expect(dismiss).not.toHaveBeenCalled();
  await act(async () => {
    if (kind === "hover") toast?.dispatchEvent(new Event("pointerout", { bubbles: true }));
    else close?.blur();
  });
  await advance(5000);
  expect(dismiss).toHaveBeenCalledOnce();
});

test("restarts identical errors and cancels the old notification timer", async () => {
  await mount();
  await advance(4000);
  await mount(2);
  await advance(1000);
  expect(dismiss).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());
  expect(dismiss).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  await advance(10000);
  expect(dismiss).toHaveBeenCalledOnce();
});
