import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Conversation } from "../src/components/Conversation.tsx";
import type { RunView, ViewBlock } from "../src/types.ts";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { highlights: new Map(), escape: (value: string) => value });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const thinking = (id: string, text: string): Exclude<ViewBlock, { type: "tool" }> => ({
  id,
  messageId: "response",
  type: "thinking",
  text,
});
const render = (orderedBlocks: ViewBlock[], overrides: Partial<RunView> = {}) =>
  act(async () =>
    root.render(
      createElement(Conversation, {
        view: {
          sessionId: "s",
          seq: 1,
          title: "test",
          runs: [
            {
              runId: "r",
              status: "running",
              startedAt: 1000,
              userMessage: "check",
              finalAnswerBlockIds: [],
              orderedBlocks,
              ...overrides,
            },
          ],
        },
        onLink: vi.fn(),
        persistReading: false,
      }),
    ),
  );

it("updates one card through streamed items while retaining its expanded state and total duration", async () => {
  const first = { ...thinking("first", "检查合同"), startedAt: 1000, streaming: true };
  await render([first]);
  const card = container.querySelector('[data-testid="thinking-block"]');
  const button = card?.querySelector<HTMLButtonElement>("button");
  expect(card?.querySelector(".thinking-summary")?.textContent).toBe("检查合同");
  await act(async () => button?.click());
  const closed = { ...first, streaming: false, endedAt: 3000 };
  const second = { ...thinking("second", ""), startedAt: 3000, streaming: true };
  await render([closed, second]);
  expect(container.querySelectorAll('[data-testid="thinking-block"]')).toHaveLength(1);
  expect(container.querySelector('[data-testid="thinking-block"] button')).toBe(button);
  expect(button?.getAttribute("aria-expanded")).toBe("true");
  await render([closed, { ...second, text: "检查金额" }]);
  expect(card?.querySelector(".thinking-body")?.textContent).toBe("检查合同\n\n检查金额");
  await act(async () => button?.click());
  expect(card?.querySelector(".thinking-summary")?.textContent).toBe("检查金额");
  const finished = { ...second, text: "检查金额", streaming: false, endedAt: 7000 };
  await render([closed, finished]);
  expect(button?.textContent).toBe("思考·持续了 6 秒");
  expect(button?.getAttribute("aria-expanded")).toBe("false");
  await act(async () => button?.click());
  expect(card?.querySelector(".thinking-body")?.textContent).toBe("检查合同\n\n检查金额");
  // Reloaded history has the original item identities and no recorded live timings.
  await act(async () => root.render(null));
  await render([thinking("first", "检查合同"), thinking("second", "检查金额")], { status: "completed" });
  const restored = container.querySelector('[data-testid="thinking-block"]');
  expect(container.querySelectorAll('[data-testid="thinking-block"]')).toHaveLength(1);
  expect(restored?.querySelector("button")?.textContent).toBe("思考·持续了几秒");
  await act(async () => restored?.querySelector<HTMLButtonElement>("button")?.click());
  expect(restored?.querySelector(".thinking-body")?.textContent).toBe("检查合同\n\n检查金额");
});

it("keeps a compaction divider after the last item of a merged card", async () => {
  await render(
    [thinking("first", "检查合同"), thinking("second", "检查金额"), thinking("third", "整理结果")],
    {
      compactions: [{ id: "compact", status: "completed", origin: "auto", afterBlockId: "second" }],
    },
  );
  expect(
    Array.from(
      container.querySelectorAll('[data-testid="thinking-block"], [data-testid="compaction-divider"]'),
      (node) => node.getAttribute("data-testid"),
    ),
  ).toEqual(["thinking-block", "compaction-divider", "thinking-block"]);
});
