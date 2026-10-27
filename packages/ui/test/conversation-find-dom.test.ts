import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildMentionMarkdown } from "zpi-coding-agent/input";
import { Conversation, RunGroup } from "../src/components/Conversation.tsx";
import {
  createConversationFindIndex,
  useConversationFindTargets,
} from "../src/components/conversation-find.ts";
import { FindDomIndex } from "../src/components/find-dom.ts";
import { Markdown } from "../src/components/Markdown.tsx";
import * as markdownFind from "../src/components/markdown-find.ts";
import type { FindTarget } from "../src/find.ts";
import type { RunView } from "../src/types.ts";

let container: HTMLDivElement, root: Root;
const workspace = { cwd: "/workspace", home: "/home" };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

it.each([
  "一段跨**格式**匹配，~~删除~~，~保留~，`代码`，&amp; 😀İ。\n\n第二段。",
  "# 标题\n\n前文\n软换行\n\n> 引用\n>\n> 下一段\n\n- 列表 A\n- **列表 B**\n\n- [x] 完成\n- [ ] 待办\n\n末尾",
  "[链接**文案**](https://example.com/private-url) [文件文案](./notes.md) [引用][r]\n\n[r]: https://example.org\n\n<https://example.net>",
  '文件 :zcode-file-citation{path="src/main.ts"}，`inline`。\n\n```text\nconst a = 1;\n// second\n```\n\n结束。',
  "前文\n\n| 标题一 | 标题二 |\n| --- | --- |\n| 跨**格式** | `代码` |\n| 新行 | [链接](https://example.org) |\n\n末尾",
  "公式 $x^2$，$5 和 $10。\n\n$$\n\\frac{a}{b} = c\n$$\n\n结束。",
  "正文<!-- comment --> <span>内容</span>\n\n<script>private</script>\n\n结尾。",
  "文字 ![图片替代文案](./picture.png) 文字\n\n![another](https://example.org/picture.png)\n\n![last](./last.png)",
  "引用[^n]。\n\n[^n]: 注脚内容。",
  "```js,filename\nconst a=1;\n```",
])("projects exactly the same searchable text as rendered Markdown: %s", async (text) => {
  const projected = markdownFind.createMarkdownFindText(workspace)(text);
  await act(async () =>
    root.render(
      createElement(Markdown, { text, streaming: false, workspace, onLink: vi.fn(), onFile: vi.fn() }),
    ),
  );
  const rendered = new FindDomIndex().target(container, "message").text;
  expect(projected).toBe(rendered);
});

it("keeps dynamic diagrams on the mounted text path", () => {
  const read = markdownFind.createMarkdownFindText(workspace);
  expect(read("```mermaid\ngraph LR\nA --> B\n```")).toBeUndefined();
  expect(read("```\ngraph LR\nA --> B\n```")).toBeUndefined();
  expect(read("```text\nordinary source\n```")).toBeTypeOf("string");
  expect(read("[](./report.pdf)")).toBeUndefined();
  expect(read("<pre>raw preformatted content</pre>")).toBeUndefined();
});

it.each([
  { text: "Read this ", paths: ["/workspace/report.pdf"] },
  {
    text: buildMentionMarkdown("report.pdf", "/workspace/report.pdf"),
    paths: ["/workspace/report.pdf", "/workspace/next.md"],
  },
  { text: "Read ", paths: ["/workspace/a.ts", "/workspace/b.ts"] },
])("projects independent file labels in exactly rendered order: %j", async ({ text, paths }) => {
  const run: RunView = {
    runId: "run",
    status: "completed",
    startedAt: 1,
    userMessage: text,
    fileReferences: paths,
    orderedBlocks: [],
    finalAnswerBlockIds: [],
  };
  await act(async () =>
    root.render(
      createElement(RunGroup, {
        run,
        expanded: false,
        onToggle: vi.fn(),
        blocks: {},
        onBlockToggle: vi.fn(),
        onLink: vi.fn(),
        onFile: vi.fn(),
        workspace,
      }),
    ),
  );
  const user = container.querySelector('[data-find-key="run:user"]');
  if (!user) throw new Error("Missing user message");
  expect(createConversationFindIndex(workspace, [], []).read(run)[0].text).toBe(
    new FindDomIndex().target(user, "user").text,
  );
});

it("reveals a counted interrupted reply at both run and block level", async () => {
  vi.stubGlobal("CSS", { highlights: new Map(), escape: (value: string) => value });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      priority = 0;
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  const run: RunView = {
    runId: "run",
    status: "completed",
    startedAt: 1,
    userMessage: "Question",
    orderedBlocks: [
      { id: "interrupted", messageId: "a", type: "text", text: "UNIQUE_HIDDEN_REPLY", interrupted: true },
      { id: "final", messageId: "b", type: "text", text: "final" },
    ],
    finalAnswerBlockIds: ["final"],
  };
  const onState = vi.fn();
  await act(async () =>
    root.render(
      createElement(Conversation, {
        view: { sessionId: "session", seq: 1, title: "test", runs: [run] },
        onLink: vi.fn(),
        persistReading: false,
        findRequest: { query: "UNIQUE_HIDDEN_REPLY", activeIndex: 0, navigationId: 1 },
        onFindStateChange: onState,
      }),
    ),
  );
  await vi.waitFor(() => {
    expect(onState).toHaveBeenLastCalledWith({ total: 1, activeIndex: 0 });
    expect(
      container.querySelector('[data-testid="interrupted-reply"] button')?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(container.querySelector('[data-find-key="interrupted"]')?.textContent).toContain(
      "UNIQUE_HIDDEN_REPLY",
    );
  });
});

it("indexes only user labels and assistant prose while preserving run navigation and final keys", () => {
  const run: RunView = {
    runId: "run-a",
    status: "completed",
    startedAt: 1,
    userMessage: `请查看 ${buildMentionMarkdown("notes", "/workspace/src/notes.md")} /init @reviewer`,
    orderedBlocks: [
      { id: "thinking", messageId: "a", type: "thinking", text: "private reasoning" },
      { id: "process", messageId: "a", type: "text", text: "过程**正文**" },
      { id: "last", messageId: "b", type: "text", text: "最终**正文**" },
    ],
    finalAnswerBlockIds: ["last"],
  };
  const index = createConversationFindIndex(workspace, [], ["reviewer"]);
  const targets = index.read(run);
  expect(targets.map(({ key, text, runId }) => ({ key, text, runId }))).toEqual([
    { key: "run-a:user", text: "请查看 notes Init reviewer", runId: "run-a" },
    { key: "process", text: "过程正文", runId: "run-a" },
    { key: "run-a:answer", text: "最终正文", runId: "run-a" },
  ]);
  expect(index.read(run)).toBe(targets);
  expect(index.read({ ...run, status: "running" }).filter((target) => target.rendered)).toHaveLength(2);
  expect(index.read({ ...run, kind: "compact" })).toEqual([]);
});

it("indexes a background result heading using the same rendered key", async () => {
  const run: RunView = {
    runId: "background",
    status: "completed",
    startedAt: 1,
    userMessage: "internal notification",
    subagentNotification: { agentId: "task", agentType: "reviewer", description: "后台审查结果" },
    orderedBlocks: [],
    finalAnswerBlockIds: [],
  };
  await act(async () =>
    root.render(
      createElement(RunGroup, {
        run,
        expanded: false,
        onToggle: vi.fn(),
        blocks: {},
        onBlockToggle: vi.fn(),
        onLink: vi.fn(),
      }),
    ),
  );
  const heading = container.querySelector('[data-find-key="background:user"]');
  expect(heading).not.toBeNull();
  expect(createConversationFindIndex(workspace, [], []).read(run)[0].text).toBe(
    heading && new FindDomIndex().target(heading, "background:user").text,
  );
});

it("yields between index batches, reuses stable history and cancels closed or replaced searches", async () => {
  vi.useFakeTimers();
  try {
    const names: string[] = [];
    const runs: RunView[] = Array.from({ length: 20 }, (_, i) => ({
      runId: `run-${i}`,
      status: "completed",
      startedAt: 1,
      userMessage: `Question ${i}`,
      orderedBlocks: [],
      finalAnswerBlockIds: [],
    }));
    let targets: readonly FindTarget[] = [];
    function Harness({
      active,
      sessionId,
      items = runs,
    }: {
      active: boolean;
      sessionId: string;
      items?: RunView[];
    }) {
      targets = useConversationFindTargets({
        runs: items,
        active,
        sessionId,
        workspace,
        commandNames: [...names],
        agentNames: [...names],
      });
      return null;
    }
    const render = async (active: boolean, sessionId = "a", items = runs) => {
      await act(async () => root.render(createElement(Harness, { active, sessionId, items })));
    };
    const step = async () => act(async () => vi.advanceTimersToNextTimerAsync());
    await render(false);
    const empty = targets;
    await render(false, "inactive-session");
    expect(targets).toBe(empty);
    expect(vi.getTimerCount()).toBe(0);
    await render(true);
    expect(targets).toHaveLength(0);
    await step();
    expect(targets).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(1);
    await render(false);
    expect(targets).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await render(true);
    await act(async () => vi.runAllTimersAsync());
    expect(targets).toHaveLength(20);
    const initial = targets;
    await render(true, "a", [...runs]);
    await step();
    expect(targets).toBe(initial);
    await render(true, "a", [...runs, { ...runs[0], runId: "new", userMessage: "new message" }]);
    await step();
    expect(targets).toHaveLength(21);
    expect(targets[0]).toBe(initial[0]);
    await render(true, "b", [{ ...runs[0], userMessage: "other session" }]);
    expect(targets).toHaveLength(0);
    await step();
    expect(targets.map((target) => target.text)).toEqual(["other session"]);
    await render(true, "c");
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  } finally {
    vi.useRealTimers();
  }
});

it("initializes the Markdown processor only for the first static prose target", () => {
  const create = vi.spyOn(markdownFind, "createMarkdownFindText");
  const index = createConversationFindIndex(workspace, [], []);
  const run: RunView = {
    runId: "run",
    status: "completed",
    startedAt: 1,
    userMessage: "Question",
    orderedBlocks: [{ id: "text", messageId: "message", type: "text", text: "**Answer**" }],
    finalAnswerBlockIds: ["text"],
  };
  index.read({ ...run, orderedBlocks: [] });
  index.read({ ...run, status: "running" });
  expect(create).not.toHaveBeenCalled();
  index.read(run);
  index.read({ ...run, runId: "another-run" });
  expect(create).toHaveBeenCalledOnce();
});

it("does not publish a previous session's delayed history failure", async () => {
  vi.stubGlobal("CSS", { highlights: new Map(), escape: (value: string) => value });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      priority = 0;
    },
  );
  let reject!: (error: Error) => void;
  const load = vi.fn(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  const run: RunView = {
    runId: "run",
    status: "completed",
    startedAt: 1,
    userMessage: "Question",
    orderedBlocks: [],
    finalAnswerBlockIds: [],
  };
  const render = (sessionId: string, hasEarlier: boolean) =>
    root.render(
      createElement(Conversation, {
        view: { sessionId, seq: 0, title: "test", runs: [run] },
        onLink: vi.fn(),
        hasEarlier,
        onLoadEarlier: load,
        historyCursor: 10,
        persistReading: false,
        findRequest: { query: "needle", activeIndex: 0, navigationId: 1 },
      }),
    );
  await act(async () => render("a", true));
  expect(load).toHaveBeenCalledOnce();
  await act(async () => render("b", false));
  await act(async () => reject(new Error("late failure from a")));
  expect(container.textContent).not.toContain("late failure from a");
});

it.each([1, 60])("keeps a clamped pixel bookmark until content can restore it (%i runs)", async (count) => {
  vi.useFakeTimers();
  const key = "zpi.reading.delayed-layout";
  const saved = JSON.stringify({ top: 1200, following: false, cursor: 0 });
  localStorage.setItem(key, saved);
  let height = 600;
  let resize = () => {};
  vi.stubGlobal("CSS", { highlights: new Map(), escape: (value: string) => value });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe(node: Element) {
        if (node.classList.contains("conversation")) resize = this.callback;
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  try {
    await act(async () =>
      root.render(
        createElement(Conversation, {
          view: {
            sessionId: "delayed-layout",
            seq: 0,
            title: "test",
            runs: Array.from(
              { length: count },
              (_, i): RunView => ({
                runId: `run-${i}`,
                status: "completed",
                startedAt: 1,
                userMessage: "Question",
                orderedBlocks: [],
                finalAnswerBlockIds: [],
              }),
            ),
          },
          onLink: vi.fn(),
        }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(localStorage.getItem(key)).toBe(saved);
    height = 4000;
    await act(async () => resize());
    const conversation = container.querySelector<HTMLElement>(".conversation");
    expect(conversation?.scrollTop).toBe(1200);
    await act(async () => conversation?.dispatchEvent(new Event("scroll", { bubbles: true })));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(JSON.parse(localStorage.getItem(key) ?? "null")?.top).toBe(1200);
  } finally {
    localStorage.removeItem(key);
    vi.useRealTimers();
  }
});
