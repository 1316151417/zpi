import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InputNotice } from "../src/components/InputNotice.tsx";
import { ModelWaitNotice } from "../src/components/ModelWaitNotice.tsx";
import { Notice } from "../src/components/Notice.tsx";

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
  act(async () =>
    root.render(createElement(Notice, { key, scope: "window", message: "文件不存在", onDismiss: dismiss })),
  );
const advance = (time: number) => act(async () => vi.advanceTimersByTime(time));

test("window notices announce, dismiss and expire after five seconds", async () => {
  const previousFocus = document.activeElement;
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("文件不存在");
  expect(container.querySelector(".notice-window")).not.toBeNull();
  expect(document.activeElement).toBe(previousFocus);
  await advance(4999);
  expect(dismiss).not.toHaveBeenCalled();
  await advance(1);
  expect(dismiss).toHaveBeenCalledOnce();
});

test.each(["hover", "focus"])(
  "keeps window notices available while the user reads them with %s",
  async (kind) => {
    await mount();
    const notice = container.querySelector<HTMLElement>('[role="alert"]');
    const close = container.querySelector<HTMLButtonElement>("button");
    await act(async () => {
      if (kind === "hover") notice?.dispatchEvent(new Event("pointerover", { bubbles: true }));
      else close?.focus();
    });
    await advance(8000);
    expect(dismiss).not.toHaveBeenCalled();
    await act(async () => {
      if (kind === "hover") notice?.dispatchEvent(new Event("pointerout", { bubbles: true }));
      else close?.blur();
    });
    await advance(5000);
    expect(dismiss).toHaveBeenCalledOnce();
  },
);

test("restarts identical window notices and cancels the old notification timer", async () => {
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

test("keeps input and turn notices until the owner resolves them", async () => {
  for (const scope of ["input", "turn"] as const) {
    await act(async () =>
      root.render(createElement(Notice, { key: scope, scope, message: "保留草稿", onDismiss: dismiss })),
    );
    expect(container.querySelector(`[data-notice-scope="${scope}"]`)).not.toBeNull();
    await advance(10000);
    expect(dismiss).not.toHaveBeenCalled();
  }
});

test("renders config warnings as non-dismissible status rows", async () => {
  await act(async () =>
    root.render(
      createElement(Notice, { scope: "config", tone: "warning", message: "先在设置中添加提供商和模型。" }),
    ),
  );
  const notice = container.querySelector('[role="status"]');
  expect(notice?.textContent).toBe("先在设置中添加提供商和模型。");
  expect(notice?.className).toContain("notice-config");
  expect(container.querySelector("button")).toBeNull();
});

test("offers an explicit action next to the message", async () => {
  const retry = vi.fn();
  await act(async () =>
    root.render(
      createElement(Notice, {
        scope: "turn",
        message: "加载失败",
        action: { label: "重试", onClick: retry },
      }),
    ),
  );
  await act(async () => container.querySelector<HTMLButtonElement>(".notice-action")?.click());
  expect(retry).toHaveBeenCalledOnce();
  expect(container.querySelector(".notice-message")?.textContent).toBe("加载失败");
});

const inputNotice = (key = 1) =>
  act(async () => root.render(createElement(InputNotice, { key, message: "附件太多", onDismiss: dismiss })));

test("input details close at three seconds and the single indicator expires at eight", async () => {
  await inputNotice();
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("附件太多");
  await advance(3000);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(dismiss).not.toHaveBeenCalled();
  await advance(4999);
  expect(dismiss).not.toHaveBeenCalled();
  await advance(1);
  expect(dismiss).toHaveBeenCalledOnce();
});

test.each(["hover", "focus"])("input expiry waits for the reader to leave (%s)", async (kind) => {
  await inputNotice();
  const trigger = container.querySelector<HTMLButtonElement>("button");
  await act(async () => {
    if (kind === "hover") trigger?.dispatchEvent(new Event("pointerover", { bubbles: true }));
    else trigger?.focus();
  });
  await advance(9000);
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  expect(dismiss).not.toHaveBeenCalled();
  await act(async () => {
    if (kind === "hover") trigger?.dispatchEvent(new Event("pointerout", { bubbles: true }));
    else trigger?.blur();
  });
  await advance(100);
  expect(dismiss).toHaveBeenCalledOnce();
});

test("new occurrences restart input timers while ordinary renders do not", async () => {
  await inputNotice();
  await advance(2000);
  await inputNotice();
  await advance(1000);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await inputNotice(2);
  await advance(2999);
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  await advance(1);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await advance(4999);
  expect(dismiss).not.toHaveBeenCalled();
  await advance(1);
  expect(dismiss).toHaveBeenCalledOnce();
});

test("model wait seconds update locally without repeating the live announcement", async () => {
  vi.setSystemTime(100_000);
  const wait = { phase: "first_response" as const, startedAt: 80_000 };
  const retry = vi.fn(async () => true);
  await act(async () => root.render(createElement(ModelWaitNotice, { wait, onRetry: retry })));
  expect(container.querySelector(".notice-message")?.textContent).toContain("已等待 20 秒");
  const announcement = container.querySelector('[role="status"]');
  const text = announcement?.textContent;
  expect(text).toContain("正在等待模型首次响应");
  expect(text).not.toContain("秒");
  expect(container.querySelector(".notice")?.hasAttribute("role")).toBe(false);
  expect(vi.getTimerCount()).toBe(1);
  await advance(1000);
  expect(container.querySelector(".notice-message")?.textContent).toContain("已等待 21 秒");
  expect(announcement?.textContent).toBe(text);
  await act(async () => root.render(createElement(ModelWaitNotice, { wait: { ...wait }, onRetry: retry })));
  await advance(2000);
  expect(container.querySelector(".notice-message")?.textContent).toContain("已等待 23 秒");
  expect(vi.getTimerCount()).toBe(1);
  expect(retry).not.toHaveBeenCalled();
});

test("model retry blocks repeated clicks and retains failures across equal waiting snapshots", async () => {
  let reject!: (error: Error) => void;
  const retry = vi.fn(() => new Promise<boolean>((_, fail) => (reject = fail)));
  const wait = { phase: "stream" as const, startedAt: Date.now() - 20_000 };
  const render = () =>
    act(async () => root.render(createElement(ModelWaitNotice, { wait: { ...wait }, onRetry: retry })));
  await render();
  const button = container.querySelector<HTMLButtonElement>(".notice-action");
  await act(async () => {
    button?.click();
    button?.click();
  });
  expect(retry).toHaveBeenCalledOnce();
  expect(button?.disabled).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("正在重试模型请求。");
  await act(async () => reject(new Error("重试连接失败")));
  expect(button?.disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("重试连接失败");
  await render();
  await advance(5000);
  expect(container.querySelector(".notice-message")?.textContent).toContain("重试连接失败");
  retry.mockResolvedValueOnce(true);
  await act(async () => button?.click());
  expect(retry).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector(".notice-message")?.textContent).toContain("模型暂时没有新输出");
});

test("new waiting state ignores a previous retry result and unmount clears the local timer", async () => {
  vi.setSystemTime(100_000);
  let reject!: (error: Error) => void;
  const retry = vi.fn(() => new Promise<boolean>((_, fail) => (reject = fail)));
  await act(async () =>
    root.render(
      createElement(ModelWaitNotice, {
        wait: { phase: "first_response", startedAt: 80_000 },
        onRetry: retry,
      }),
    ),
  );
  await act(async () => container.querySelector<HTMLButtonElement>(".notice-action")?.click());
  await act(async () =>
    root.render(
      createElement(ModelWaitNotice, {
        wait: { phase: "stream", startedAt: 99_000 },
        onRetry: retry,
      }),
    ),
  );
  expect(container.querySelector<HTMLButtonElement>(".notice-action")?.disabled).toBe(false);
  await act(async () => reject(new Error("stale failure")));
  expect(container.textContent).not.toContain("stale failure");
  expect(container.querySelector(".notice-message")?.textContent).toContain("已等待 1 秒");
  await act(async () => container.querySelector<HTMLButtonElement>(".notice-action")?.click());
  await act(async () => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => reject(new Error("unmounted failure")));
  await advance(5000);
  expect(container.textContent).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});

test("reconnect notices do not start a clock and omit retry guidance without a retry action", async () => {
  await act(async () => root.render(createElement(ModelWaitNotice)));
  expect(container.querySelector(".notice-message")?.textContent).toBe("正在等待重新连接。可以继续等待。");
  expect(container.querySelector("button")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
