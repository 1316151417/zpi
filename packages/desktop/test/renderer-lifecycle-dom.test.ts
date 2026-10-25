import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SessionView, UserQuestionRequest } from "zpi-ui";
import { Conversation, emptySession } from "zpi-ui";
import { AppBoundary } from "../src/renderer/AppBoundary.tsx";
import { BackgroundTaskPane } from "../src/renderer/BackgroundTaskPane.tsx";
import { logRendererError } from "../src/renderer/error-log.ts";
import QuickChatConversation from "../src/renderer/QuickChatConversation.tsx";
import { SubagentPane } from "../src/renderer/SubagentPane.tsx";

const state = vi.hoisted(() => ({
  views: new Map<string, SessionView>(),
  historyCursors: new Map(),
  historyLoading: new Set(),
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: (select: (state: object) => unknown) => select(state),
  questionDrafts: new Map(),
  report: vi.fn(),
  loadEarlier: vi.fn(),
}));
vi.mock("../src/renderer/pane-store.ts", () => ({
  paneTask: vi.fn(),
  openChanges: vi.fn(),
  openFile: vi.fn(),
  openWebLink: vi.fn(),
}));
vi.mock("../src/renderer/use-workspace.ts", () => ({ useWorkspace: () => ({ cwd: "/repo" }) }));
vi.mock("../src/renderer/error-log.ts", () => ({ logRendererError: vi.fn() }));
vi.mock("zpi-ui", async (original) => ({
  ...(await original<typeof import("zpi-ui")>()),
  Conversation: vi.fn(() => null),
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
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

test("background output polling resumes after a transient read failure and stops at completion", async () => {
  vi.useFakeTimers();
  const task = { taskId: "task", command: "work", status: "running", outputPath: "/log" };
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporary failure"))
    .mockResolvedValueOnce({ ok: true, value: { task, output: "working" } })
    .mockResolvedValueOnce({
      ok: true,
      value: { task: { ...task, status: "completed" }, output: "finished" },
    });
  Object.defineProperty(window, "zpi", { configurable: true, value: { readBackgroundTask: read } });
  await act(async () =>
    root.render(createElement(BackgroundTaskPane, { sessionId: "s", taskId: "task", visible: true })),
  );
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(container.querySelector("pre")?.textContent).toBe("working");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.querySelector("pre")?.textContent).toBe("finished");
  expect(read).toHaveBeenCalledTimes(3);
});

test("the root boundary displays a recoverable error and records a shell render exception", async () => {
  const warning = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = new Error("shell render failed");
  function Broken(): never {
    throw error;
  }
  try {
    await act(async () => root.render(createElement(AppBoundary, null, createElement(Broken))));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法显示窗口");
    expect(container.querySelector("button")?.textContent).toBe("重新加载");
    expect(logRendererError).toHaveBeenCalledWith("app-render", error);
  } finally {
    warning.mockRestore();
  }
});

test("quick chat reuses workspace context across stream updates and updates it when cwd changes", async () => {
  const render = (cwd: string, seq: number) =>
    act(async () =>
      root.render(
        createElement(QuickChatConversation, { view: { ...emptySession("s"), seq }, cwd, onError: vi.fn() }),
      ),
    );
  await render("/repo", 1);
  const first = vi.mocked(Conversation).mock.lastCall?.[0].workspace;
  await render("/repo", 2);
  expect(vi.mocked(Conversation).mock.lastCall?.[0].workspace).toBe(first);
  await render("/other", 3);
  expect(vi.mocked(Conversation).mock.lastCall?.[0].workspace).toEqual({ cwd: "/other" });
  expect(vi.mocked(Conversation).mock.lastCall?.[0].workspace).not.toBe(first);
});

test("switching a subagent question resets its question index and answer draft", async () => {
  const question = (text: string) => ({
    question: text,
    header: "Choice",
    multiSelect: false,
    options: [
      { label: "A", description: "first" },
      { label: "B", description: "second" },
    ],
  });
  const render = async (request: UserQuestionRequest) => {
    state.views.set("child", { ...emptySession("child"), question: request });
    await act(async () =>
      root.render(
        createElement(SubagentPane, {
          tab: { type: "subagent", id: "tab", sessionId: "parent", childSessionId: "child", title: "Child" },
        }),
      ),
    );
  };
  await render({ id: "first", questions: [question("old first"), question("old second")] });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="下一题"]')?.click());
  expect(container.querySelector(".question-title")?.textContent).toBe("old second");
  await render({ id: "next", questions: [question("new first")] });
  expect(container.querySelector(".question-title")?.textContent).toBe("new first");
  expect(container.querySelector('[aria-label="问题导航"]')?.textContent).toContain("1 / 1");
});
