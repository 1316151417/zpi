import { act, type ComponentProps, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FindRequest, FindState, RunView, ViewBlock } from "zpi-ui";
import { ChangedFiles } from "../../ui/src/components/ChangedFiles.tsx";
import { ChangesPane } from "../src/renderer/ChangesPane.tsx";
import {
  activatePaneTab,
  listenPanes,
  openChanges,
  usePane,
  visiblePaneTabs,
} from "../src/renderer/pane-store.ts";
import { useStore } from "../src/renderer/store.ts";
import type { DesktopBridge, DiffItem, Result } from "../src/shared/bridge.ts";

const paths = [
  "/project/index.ts",
  "/project/quick-chat-window.ts",
  "/project/app-state.ts",
  "/project/App.tsx",
];
const appPath = paths[3];
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const patch = (path: string, text: string) => `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${text}\n`;
const entries: DiffItem[] = paths.map((path, index) => ({
  id: `file:${path}`,
  path,
  status: "created",
  area: "本轮变更",
  patch: patch(path, `file_${index}_only shared_result`),
}));
const run: RunView = {
  runId: "run-a",
  status: "completed",
  userMessage: "edit four files",
  startedAt: 0,
  finalAnswerBlockIds: [],
  orderedBlocks: entries.map((entry, index) => ({
    type: "tool",
    id: `block-${index}`,
    messageId: "assistant",
    toolCallId: `edit-${index}`,
    name: "write",
    status: "completed",
    argsText: "",
    output: "",
    fileChange: { path: entry.path, patch: entry.patch, additions: 1, deletions: 0 },
  })),
};
const bridge = {
  platform: "darwin",
  onPaneEvent: vi.fn(() => vi.fn()),
  onEvent: vi.fn(() => vi.fn()),
  getChanges: vi.fn<DesktopBridge["getChanges"]>(),
  readPatch: vi.fn<DesktopBridge["readPatch"]>(),
  getWorkspaceInfo: vi.fn(async () => ok({ cwd: "/project", branch: null, dirty: false })),
  getInstalledEditors: vi.fn(async () => ok([{ id: "vscode", name: "VS Code" }])),
  fileAction: vi.fn(async () => ok(undefined)),
  openInEditor: vi.fn(async () => ok(undefined)),
  readFilePreview: vi.fn(async (_sessionId: string, path: string) =>
    ok({ kind: "text", path, text: "source", truncated: false }),
  ),
  logError: vi.fn(),
};
let root: Root;
let container: HTMLDivElement;
let stopPanes: () => void;
const onFindStateChange = vi.fn<(state: FindState) => void>();

// Compose the real summary, store and preview; only the IPC/OS boundary is fake.
function Harness({ findRequest }: { findRequest?: FindRequest }) {
  const selected = useStore((state) => state.selected);
  const state = usePane();
  const tab = state.tabs.find((tab) => tab.id === state.active && tab.type === "changes");
  return createElement(
    "div",
    null,
    createElement(ChangedFiles, {
      run,
      cwd: "/project",
      onChanges: (runId, path) => openChanges(selected ?? "A", runId, path),
    }),
    tab?.type === "changes"
      ? createElement(ChangesPane, {
          key: tab.id,
          sessionId: tab.sessionId,
          runId: tab.runId,
          path: tab.path,
          toolCallId: tab.toolCallId,
          visible: true,
          findRequest,
          onFindStateChange,
        })
      : null,
  );
}
async function render(findRequest?: FindRequest) {
  await act(async () => root.render(createElement(Harness, { findRequest })));
}
async function click(selector: string) {
  const element = container.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  await act(async () => element?.click());
}
async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
}
function preview() {
  const element = container.querySelector<HTMLElement>(".changes-pane");
  expect(element).not.toBeNull();
  return element as HTMLElement;
}
function displayedIds() {
  return [...preview().querySelectorAll<HTMLElement>("[data-diff-id]")].map((node) => node.dataset.diffId);
}
async function find(query: string, activeIndex = 0) {
  onFindStateChange.mockClear();
  await render({ query, activeIndex, navigationId: Date.now() });
  await settle();
  return onFindStateChange.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // happy-dom lacks the browser Highlight registry; indexing/navigation remain real.
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      priority = 0;
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  vi.stubGlobal("CSS", { ...CSS, highlights: new Map() });
  window.localStorage.clear();
  window.localStorage.setItem("zpi-last-editor-id", "vscode");
  Object.defineProperty(window, "zpi", { configurable: true, value: bridge });
  bridge.getChanges.mockReset().mockResolvedValue(ok(entries));
  bridge.readPatch
    .mockReset()
    .mockImplementation(async (_session, _run, id) =>
      ok(patch(appPath, id.startsWith("operation:") ? "operation_only" : "deferred_only")),
    );
  usePane.setState({
    open: false,
    active: undefined,
    tabs: [],
    preferences: new Map(),
    deletedSessionIds: new Set(),
  });
  useStore.setState({
    selected: "A",
    sessions: new Map(
      ["A", "B"].map((id) => [
        id,
        { id, title: id, cwd: "/project", projectId: null, createdAt: 0, updatedAt: 0 },
      ]),
    ),
    views: new Map([["A", { sessionId: "A", title: "A", seq: 1, runs: [run] }]]),
    error: undefined,
  });
  stopPanes = listenPanes();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  stopPanes();
  container.remove();
  vi.unstubAllGlobals();
});

it("opens App and index as separate single-file tabs, reuses repeats, and keeps all changes navigable", async () => {
  await render();
  await click('[aria-label="查看修改 App.tsx"]');
  const appTab = usePane.getState().active;
  expect(displayedIds()).toEqual([`file:${appPath}`]);
  expect(preview().querySelector(".diff-file-list")).toBeNull();
  expect(preview().querySelector(".preview-breadcrumb")?.getAttribute("title")).toBe(appPath);
  expect(preview().querySelector(".diff-mode,.diff-heading")).toBeNull();
  await click('[aria-label="查看修改 index.ts"]');
  const indexTab = usePane.getState().active;
  expect(indexTab).not.toBe(appTab);
  expect(displayedIds()).toEqual([`file:${paths[0]}`]);
  await click('[aria-label="审查 App.tsx"]');
  expect(usePane.getState().active).toBe(appTab);
  expect(visiblePaneTabs("A").map((tab) => tab.title)).toEqual(["App.tsx", "index.ts"]);
  await act(async () => openChanges("A", null));
  expect(visiblePaneTabs("A")).toHaveLength(3);
  expect(preview().querySelectorAll(".diff-file-list button")).toHaveLength(4);
  await click(`.diff-file-list button[title="${paths[1]}"]`);
  expect(displayedIds()).toEqual([`file:${paths[1]}`]);
  await act(async () => activatePaneTab(appTab ?? ""));
  expect(displayedIds()).toEqual([`file:${appPath}`]);
  expect(preview().querySelector(".diff-file-list")).toBeNull();
});

it("isolates single-file search and lazy patch reads while all changes still searches every file", async () => {
  bridge.getChanges.mockResolvedValue(
    ok(entries.map((entry) => ({ ...entry, patch: undefined, patchAvailable: true }))),
  );
  bridge.readPatch.mockImplementation(async (_session, _run, id) =>
    ok(entries.find((entry) => entry.id === id)?.patch ?? ""),
  );
  await render();
  await click('[aria-label="查看修改 App.tsx"]');
  expect(await find("file_0_only")).toEqual({ total: 0, activeIndex: -1 });
  expect(await find("shared_result")).toEqual({ total: 1, activeIndex: 0 });
  expect(bridge.readPatch.mock.calls.every((call) => call[2] === `file:${appPath}`)).toBe(true);
  expect(displayedIds()).toEqual([`file:${appPath}`]);
  await act(async () => openChanges("A", null));
  expect(await find("file_0_only")).toEqual({ total: 1, activeIndex: 0 });
  expect(displayedIds()).toEqual([`file:${paths[0]}`]);
  expect(await find("shared_result", 2)).toEqual({ total: 4, activeIndex: 2 });
  expect(displayedIds()).toEqual([`file:${paths[2]}`]);
});

it("retains every fallback entry for the selected path and never substitutes a sibling for a missing path", async () => {
  const fallback = { ...entries[3], id: "operation:second", patch: patch(appPath, "second_only") };
  bridge.getChanges.mockResolvedValue(ok([...entries, fallback]));
  await render();
  await click('[aria-label="查看修改 App.tsx"]');
  expect(displayedIds()).toEqual([`file:${appPath}`, "operation:second"]);
  expect(preview().querySelector(".diff-file-list")).toBeNull();
  await act(async () => openChanges("A", "run-a", "/project/missing.ts"));
  expect(displayedIds()).toEqual([]);
  expect(preview().textContent).toContain("暂无文件变更");
  expect(preview().textContent).not.toContain("shared_result");
});

it("keeps per-operation patches distinct from aggregate and other-run previews", async () => {
  await render();
  await click('[aria-label="查看修改 App.tsx"]');
  const aggregateId = usePane.getState().active;
  await act(async () => openChanges("A", "run-a", appPath, "edit-3"));
  const operationId = usePane.getState().active;
  expect(operationId).not.toBe(aggregateId);
  expect(bridge.readPatch).toHaveBeenLastCalledWith("A", "run-a", "operation:edit-3");
  expect(displayedIds()).toEqual(["operation:edit-3"]);
  expect(preview().textContent).toContain("operation_only");
  expect(preview().textContent).not.toContain("file_3_only");
  await act(async () => openChanges("A", "run-a", appPath, "edit-3"));
  expect(usePane.getState().active).toBe(operationId);
  await act(async () => openChanges("A", "run-b", appPath, "edit-3"));
  expect(usePane.getState().active).not.toBe(operationId);
  expect(visiblePaneTabs("A")).toHaveLength(3);
});

it("restores legacy in-memory IDs by source fields without overwriting another file or all changes", async () => {
  const legacy = {
    id: "changes:A:run-a",
    type: "changes" as const,
    sessionId: "A",
    runId: "run-a",
    path: appPath,
    title: "App.tsx",
  };
  usePane.setState({
    tabs: [legacy],
    active: legacy.id,
    preferences: new Map([["A", { open: true, active: legacy.id }]]),
  });
  await render();
  expect(preview().querySelector(".diff-file-list")).toBeNull();
  await click('[aria-label="查看修改 App.tsx"]');
  expect(usePane.getState().active).toBe(legacy.id);
  expect(visiblePaneTabs("A")).toHaveLength(1);
  await click('[aria-label="查看修改 index.ts"]');
  await act(async () => openChanges("A", "run-a"));
  expect(visiblePaneTabs("A")).toHaveLength(3);
  expect(preview().querySelectorAll(".diff-file-list button")).toHaveLength(4);
  await act(async () => activatePaneTab(legacy.id));
  await act(async () => useStore.setState({ selected: "B" }));
  await act(async () => useStore.setState({ selected: "A" }));
  expect(usePane.getState().active).toBe(legacy.id);
  expect(displayedIds()).toEqual([`file:${appPath}`]);
});

it.each([
  { sessionId: "B", runId: "run-a", path: appPath },
  { sessionId: "A", runId: "run-b", path: appPath },
  { sessionId: "A", runId: "run-a", path: paths[0] },
])("discards delayed results when a mounted preview changes scope to %j", async (next) => {
  const older = Promise.withResolvers<Result<DiffItem[]>>();
  bridge.getChanges
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce(
      ok([{ ...entries[0], path: next.path, patch: patch(next.path, "new_scope_only") }]),
    );
  const original = { sessionId: "A", runId: "run-a", path: appPath, visible: true };
  await act(async () => root.render(createElement(ChangesPane, original)));
  await act(async () => root.render(createElement(ChangesPane, { ...original, ...next })));
  expect(preview().textContent).toContain("new_scope_only");
  await act(async () => older.resolve(ok(entries)));
  expect(preview().textContent).toContain("new_scope_only");
  expect(preview().textContent).not.toContain("file_3_only");
  expect(preview().querySelector(".preview-breadcrumb")?.getAttribute("title")).toBe(next.path);
});

it("clears an already loaded source immediately while the next source is still loading", async () => {
  const original = { sessionId: "A", runId: "run-a", path: appPath, visible: true };
  await act(async () => root.render(createElement(ChangesPane, original)));
  expect(preview().textContent).toContain("file_3_only");
  const next = Promise.withResolvers<Result<DiffItem[]>>();
  bridge.getChanges.mockReturnValueOnce(next.promise);
  await act(async () => root.render(createElement(ChangesPane, { ...original, path: paths[0] })));
  expect(preview().textContent).toContain("加载变更");
  expect(preview().textContent).not.toContain("file_3_only");
  await act(async () => next.resolve(ok(entries)));
  expect(displayedIds()).toEqual([`file:${paths[0]}`]);
});

it("recovers a missing tool path only from its own operation, and never falls back to all changes", async () => {
  await act(async () =>
    root.render(
      createElement(ChangesPane, { sessionId: "A", runId: "run-a", toolCallId: "edit-3", visible: true }),
    ),
  );
  expect(displayedIds()).toEqual(["operation:edit-3"]);
  expect(preview().querySelector(".preview-breadcrumb")?.getAttribute("title")).toBe(appPath);
  await act(async () =>
    root.render(
      createElement(ChangesPane, {
        sessionId: "A",
        runId: "run-a",
        toolCallId: "missing-tool",
        visible: true,
      }),
    ),
  );
  expect(preview().querySelector('[role="alert"]')?.textContent).toContain("从工具卡片重新打开");
  expect(displayedIds()).toEqual([]);
  expect(bridge.getChanges).not.toHaveBeenCalled();
});

it("renders historical deletion patches without needing the file to exist", async () => {
  bridge.getChanges.mockResolvedValue(
    ok([
      {
        ...entries[3],
        status: "deleted",
        patch: `--- a/${appPath}\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed_only\n`,
      },
    ]),
  );
  await render();
  await click('[aria-label="查看修改 App.tsx"]');
  expect(preview().querySelector(".tool-diff-line.removed")?.textContent).toContain("removed_only");
  expect(preview().querySelector(".diff-file-list")).toBeNull();
  expect(bridge.readFilePreview).not.toHaveBeenCalled();
});

it("retains source preview, path-copy menu and default application actions with their exact file scope", async () => {
  await render();
  await click('[aria-label="查看修改 App.tsx"]');
  await click('[aria-label="使用默认程序打开"]');
  expect(bridge.fileAction).toHaveBeenCalledExactlyOnceWith("A", appPath, "open");
  expect(bridge.openInEditor).not.toHaveBeenCalled();
  bridge.fileAction.mockClear();
  const menuTrigger = preview().querySelector<HTMLButtonElement>('[aria-label="文件预览菜单"]');
  await act(async () =>
    menuTrigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  const menuItems = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(menuItems.map((item) => item.textContent)).toEqual(["复制绝对路径", "复制相对路径"]);
  await act(async () => menuItems[1].click());
  expect(bridge.fileAction).toHaveBeenCalledExactlyOnceWith("A", appPath, "copy-relative");
  await click(".preview-source");
  expect(bridge.readFilePreview).toHaveBeenCalledExactlyOnceWith("A", appPath, undefined);
  expect(visiblePaneTabs("A").at(-1)?.type).toBe("file");
});

it("keeps a selected streaming operation mounted through completion, then loads only its final patch", async () => {
  const streaming: Extract<ViewBlock, { type: "tool" }> = {
    ...(run.orderedBlocks[3] as Extract<ViewBlock, { type: "tool" }>),
    status: "preparing",
    fileChange: undefined,
    argsText: '{"path":"/project/App.tsx","content":"selected_prefix',
  };
  const update = (block: ViewBlock) =>
    useStore.setState({
      views: new Map([
        [
          "A",
          {
            sessionId: "A",
            title: "A",
            seq: 1,
            runs: [{ ...run, status: "running", orderedBlocks: [block] }],
          },
        ],
      ]),
    });
  update(streaming);
  const props: ComponentProps<typeof ChangesPane> = {
    sessionId: "A",
    runId: "run-a",
    path: appPath,
    toolCallId: "edit-3",
    visible: true,
  };
  await act(async () => root.render(createElement(ChangesPane, props)));
  const text = preview().querySelector("code")?.firstChild;
  expect(text).toBeTruthy();
  const range = document.createRange();
  range.selectNodeContents(text as Node);
  document.getSelection()?.addRange(range);
  await act(async () => update(run.orderedBlocks[3]));
  expect(preview().querySelector(".pending-file-preview")).not.toBeNull();
  expect(bridge.readPatch).not.toHaveBeenCalled();
  await act(async () => {
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(preview().querySelector(".pending-file-preview")).toBeNull();
  expect(displayedIds()).toEqual(["operation:edit-3"]);
  expect(bridge.readPatch).toHaveBeenLastCalledWith("A", "run-a", "operation:edit-3");
  expect(bridge.getChanges).not.toHaveBeenCalled();
});
