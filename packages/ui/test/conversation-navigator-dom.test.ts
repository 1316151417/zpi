import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationNavigator } from "../src/components/ConversationNavigator.tsx";
import { conversationQueries } from "../src/conversation-run-partition.ts";
import type { RunView } from "../src/types.ts";

const run = (id: string): RunView => ({
  runId: id,
  status: "completed",
  startedAt: 1,
  userMessage: `Question ${id}`,
  orderedBlocks: [],
  finalAnswerBlockIds: [],
});
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("jumps to the selected run and windows a long rail", async () => {
  const onJump = vi.fn();
  const runs = Array.from({ length: 200 }, (_, index) => run(String(index)));
  const scroll = document.createElement("div");
  const first = document.createElement("div");
  first.dataset.queryKey = "0:user";
  const second = document.createElement("div");
  second.dataset.queryKey = "1:user";
  let secondTop = 100;
  vi.spyOn(first, "getBoundingClientRect").mockReturnValue({ top: -10 } as DOMRect);
  vi.spyOn(second, "getBoundingClientRect").mockImplementation(() => ({ top: secondTop }) as DOMRect);
  scroll.append(first, second);
  await act(async () =>
    root.render(
      createElement(ConversationNavigator, {
        history: runs.flatMap(conversationQueries),
        onJump,
        busy: false,
        scrollRoot: { current: scroll },
      }),
    ),
  );
  const buttons = container.querySelectorAll<HTMLButtonElement>("button");
  expect(buttons.length).toBeGreaterThan(1);
  expect(buttons.length).toBeLessThan(200);
  expect(buttons[0]?.getAttribute("aria-current")).toBe("location");
  expect(buttons[1]?.getAttribute("aria-label")).toBe("跳转到第 2 条问题");
  secondTop = 0;
  await act(async () => scroll.dispatchEvent(new Event("scroll")));
  expect(buttons[1]?.getAttribute("aria-current")).toBe("location");
  await act(async () => buttons[1]?.click());
  expect(onJump).toHaveBeenCalledWith("1", "1:user");
});

it("shows the working placeholder until settled, then the same final answer as the message body", async () => {
  const text = (id: string, value: string) => ({ id, messageId: id, type: "text" as const, text: value });
  const intro = text("intro", "我先读取方案并核对配置。");
  const answer = text("answer", "已更新方案。\n\n确认三个问题。\n\n第三段不展示。");
  const view: RunView = {
    ...run("current"),
    status: "running",
    orderedBlocks: [intro, answer],
    finalAnswerBlockIds: [intro.id, answer.id],
  };
  const render = async (current: RunView) =>
    act(async () =>
      root.render(
        createElement(ConversationNavigator, {
          history: [run("older"), current].flatMap(conversationQueries),
          onJump: vi.fn(),
          busy: false,
          scrollRoot: { current: null },
        }),
      ),
    );
  await render(view);
  const button = container.querySelectorAll("button")[1];
  if (!button) throw new Error("Missing current query navigator item");
  await act(async () => {
    button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
  const preview = () => document.querySelector(".conversation-navigator-answer")?.textContent;
  expect(preview()).toBe("助手仍在工作");
  await render({ ...view, status: "completed" });
  expect(preview()).toBe("已更新方案。\n确认三个问题。");
  await render({ ...view, status: "completed", finalAnswerBlockIds: [] });
  expect(preview()).toBe("暂无助手正文");
  await render({ ...view, status: "completed", orderedBlocks: [intro, text("answer", "结".repeat(230))] });
  expect(preview()).toBe(`${"结".repeat(217)}...`);
  await render({ ...view, status: "running" });
  expect(preview()).toBe("助手仍在工作");
});
