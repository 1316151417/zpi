import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deferred } from "../../../tests/fake-server.ts";
import { useStore } from "../src/renderer/store.ts";
import { TaskSearchDialog } from "../src/renderer/TaskSearchDialog.tsx";
import { useWorkspaceFileSearch } from "../src/renderer/use-workspace-file-search.ts";
import { WorkspaceFileTree } from "../src/renderer/workspace-file-tree/WorkspaceFileTree.tsx";
import type { WorkspaceFileSearchResult } from "../src/shared/workspace-files.ts";

vi.mock("../src/renderer/workspace-file-tree/use-tree-data.ts", () => {
  const data = {
    rows: [],
    gitStatusAvailable: false,
    gitStatusByPath: new Map(),
    ignoredPathSet: new Set(),
    loadedDirectoryPaths: new Set(["/repo"]),
    errorByDirectory: new Map(),
    loadingDirectoryPaths: new Set(),
    refreshingLoadedDirectories: false,
    loadDirectory: async () => {},
    setExpandedPaths: () => {},
    refreshLoadedDirectories: async () => {},
  };
  return { useWorkspaceFileTreeData: () => data };
});
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 28, size: 28 })),
    scrollToIndex: () => {},
    measureElement: () => {},
  }),
}));
const search = vi.fn();
const cancel = vi.fn();
let root: Root;
let container: HTMLDivElement;
const result = (names: string[], extra = {}): WorkspaceFileSearchResult => ({
  entries: names.map((name) => ({ name, path: name, absolutePath: `/repo/${name}`, type: "file" })),
  truncated: false,
  incomplete: false,
  ...extra,
});
async function fill(label: string, text: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  search.mockReset().mockResolvedValue({ ok: true, value: result([]) });
  cancel.mockReset().mockResolvedValue({ ok: true, value: undefined });
  Object.defineProperty(window, "zpi", {
    configurable: true,
    value: {
      platform: "darwin",
      searchWorkspaceFiles: search,
      cancelWorkspaceFileSearch: cancel,
      searchTasks: async () => ({ ok: true, value: [] }),
      getTaskSearchChanges: async () => ({ ok: true, value: [] }),
      getInstalledEditors: async () => ({ ok: true, value: [] }),
    },
  });
  useStore.setState({ sessions: new Map(), settings: undefined });
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

test("command center and file tree send the same query and preserve backend fuzzy ranking", async () => {
  search.mockResolvedValue({ ok: true, value: result(["WorkspaceFileTree.tsx", "work-file-tool.ts"]) });
  await act(async () =>
    root.render(
      createElement(TaskSearchDialog, {
        selected: "task",
        workspaceKey: "/repo",
        projects: [],
        commands: [],
        onClose: vi.fn(),
        onSelectTask: vi.fn(),
        onOpenFile: vi.fn(),
      }),
    ),
  );
  await fill("搜索操作、任务或文件", "wft");
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(search.mock.calls[0]).toMatchObject(["task", { query: "wft", filesOnly: true }]);
  expect(
    [...document.querySelectorAll('.task-search-item[data-value^="file:"]')].map((node) => node.textContent),
  ).toEqual(["WorkspaceFileTree.tsx", "work-file-tool.ts"]);
  await act(async () =>
    root.render(
      createElement(WorkspaceFileTree, {
        sessionId: "task",
        workspacePath: "/repo",
        workspaceName: "repo",
        onOpenPreview: vi.fn(),
      }),
    ),
  );
  await fill("搜索文件", "wft");
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(search.mock.calls[1]).toMatchObject(["task", { query: "wft", rootPath: "/repo", filesOnly: false }]);
  const text = container.textContent ?? "";
  expect(text).toContain("WorkspaceFileTree.tsx");
  expect(text.indexOf("WorkspaceFileTree.tsx")).toBeLessThan(text.indexOf("work-file-tool.ts"));
});

test("partial scans show continuation and reuse its cursor instead of filtering a partial index", async () => {
  search
    .mockResolvedValueOnce({ ok: true, value: result([], { continuation: "page-2" }) })
    .mockResolvedValueOnce({ ok: true, value: result(["target.ts"], { truncated: true }) });
  await act(async () =>
    root.render(
      createElement(WorkspaceFileTree, {
        sessionId: "task",
        workspacePath: "/repo",
        workspaceName: "repo",
        onOpenPreview: vi.fn(),
      }),
    ),
  );
  await fill("搜索文件", "target");
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(container.textContent).toContain("部分目录尚未搜索");
  expect(container.textContent).not.toContain("没有匹配的文件");
  const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "继续搜索");
  await act(async () => button?.click());
  expect(search.mock.calls[1][1]).toMatchObject({
    continuation: "page-2",
    requestId: search.mock.calls[0][1].requestId,
  });
  expect(container.textContent).toContain("target.ts");
  expect(container.textContent).toContain("请缩小搜索范围");
  expect(container.textContent).not.toContain("继续搜索");
});

test("query changes cancel old scans and ignore late responses; unmount cancels the current cursor", async () => {
  let current: ReturnType<typeof useWorkspaceFileSearch> | undefined;
  function Probe({ query }: { query: string }) {
    current = useWorkspaceFileSearch({ sessionId: "task", query });
    return null;
  }
  const old = deferred<{ ok: true; value: WorkspaceFileSearchResult }>();
  search.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ok: true, value: result(["new.ts"]) });
  await act(async () => root.render(createElement(Probe, { query: "old" })));
  await act(async () => vi.advanceTimersByTimeAsync(200));
  await act(async () => root.render(createElement(Probe, { query: "new" })));
  expect(cancel).toHaveBeenCalledWith(search.mock.calls[0][1].requestId);
  await act(async () => vi.advanceTimersByTimeAsync(200));
  await act(async () => old.resolve({ ok: true, value: result(["old.ts"], { continuation: "stale" }) }));
  expect(current?.result?.entries[0]?.name).toBe("new.ts");
  await act(async () => root.render(null));
  expect(cancel).toHaveBeenCalledWith(search.mock.calls[1][1].requestId);
});

test("expired continuation restarts without reusing the invalid token", async () => {
  search
    .mockResolvedValueOnce({ ok: true, value: result([], { continuation: "expired" }) })
    .mockResolvedValueOnce({
      ok: false,
      error: { code: "invalid_input", message: "文件搜索已过期，请重新搜索" },
    })
    .mockResolvedValueOnce({ ok: true, value: result(["target.ts"]) });
  await act(async () =>
    root.render(
      createElement(WorkspaceFileTree, {
        sessionId: "task",
        workspacePath: "/repo",
        workspaceName: "repo",
        onOpenPreview: vi.fn(),
      }),
    ),
  );
  await fill("搜索文件", "target");
  await act(async () => vi.advanceTimersByTimeAsync(200));
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
  await act(async () => button("继续搜索")?.click());
  expect(container.textContent).toContain("已过期");
  await act(async () => button("重新搜索")?.click());
  expect(search.mock.calls[2][1].continuation).toBeUndefined();
  expect(container.textContent).toContain("target.ts");
});
