import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
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
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
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
