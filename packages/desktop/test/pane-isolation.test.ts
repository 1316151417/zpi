import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  activatePaneTab,
  closeTab,
  deleteSessionWithPanes,
  listenPanes,
  openBrowser,
  openChanges,
  openFile,
  openTerminal,
  openWebLink,
  reorderPaneTab,
  setPaneOpen,
  terminalOutput,
  usePane,
  visiblePaneTabs,
} from "../src/renderer/pane-store.ts";
import { report, useStore } from "../src/renderer/store.ts";
import type { BrowserState, FilePreview, PaneEvent, Result } from "../src/shared/bridge.ts";

vi.mock("../src/renderer/store.ts", async () => {
  const { create } = await import("zustand");
  const actual = await vi.importActual<typeof import("../src/renderer/store.ts")>("../src/renderer/store.ts");
  return {
    useStore: create(() => ({ selected: undefined, sessions: new Map(), views: new Map(), projects: [] })),
    report: vi.fn(),
    closeSideChat: actual.closeSideChat,
    retainedSessionViews: actual.retainedSessionViews,
    unwrap: <T>(result: Result<T>) => {
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
  };
});
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const browser = (id: string, url = "https://example.test/"): BrowserState => ({
  id,
  url,
  title: id,
  loading: false,
  back: false,
  forward: false,
});
const file: FilePreview = { kind: "text", path: "/shared/readme.md", text: "document", truncated: false };
let off: () => void;
let event: (event: PaneEvent) => void;
let serial = 0;
const bridge = {
  onPaneEvent: vi.fn((listener: typeof event) => {
    event = listener;
    return vi.fn();
  }),
  createBrowser: vi.fn(async () => ok(browser(`browser-${++serial}`))),
  readFilePreview: vi.fn(async (): Promise<Result<FilePreview>> => ok(file)),
  getWorkspaceInfo: vi.fn(async () => ok({ cwd: "/shared" })),
  createTerminal: vi.fn(async () => ok({ id: `terminal-${++serial}`, shell: "zsh" })),
  closeBrowser: vi.fn(async (): Promise<Result<void>> => ok(undefined)),
  closeTerminal: vi.fn(async (): Promise<Result<void>> => ok(undefined)),
  deleteSession: vi.fn(async (): Promise<Result<void>> => ok(undefined)),
  closeSideChat: vi.fn(async (): Promise<Result<void>> => ok(undefined)),
};
function select(selected: string | undefined) {
  useStore.setState({ selected });
}
beforeEach(() => {
  vi.clearAllMocks();
  serial = 0;
  vi.stubGlobal("window", { zpi: bridge });
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
      ["A", "B", "C"].map((id) => [
        id,
        {
          id,
          title: id,
          cwd: id === "C" ? "/other" : "/shared",
          projectId: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ]),
    ),
    projects: [],
    views: new Map(),
  });
  off = listenPanes();
});
afterEach(() => {
  off();
  terminalOutput.clear();
  vi.unstubAllGlobals();
});

it("restores task tabs, active tab and explicit collapse preferences while retaining native instances", async () => {
  await openFile("A", file.path);
  await openBrowser();
  await openTerminal("A");
  const aTabs = visiblePaneTabs("A");
  activatePaneTab(aTabs[0].id);
  setPaneOpen(false);
  select("B");
  expect(visiblePaneTabs("B")).toEqual([]);
  expect(usePane.getState()).toMatchObject({ open: false, active: undefined });
  setPaneOpen(true);
  select("A");
  expect(usePane.getState()).toMatchObject({ open: false, active: aTabs[0].id });
  expect(visiblePaneTabs("A")).toEqual(aTabs);
  select("B");
  expect(usePane.getState()).toMatchObject({ open: true, active: undefined });
  await openFile("B", file.path);
  expect(visiblePaneTabs("B")[0].id).not.toBe(aTabs[0].id);
  await openFile("B", file.path);
  expect(visiblePaneTabs("B")).toHaveLength(1);
  expect(bridge.closeBrowser).not.toHaveBeenCalled();
  expect(bridge.closeTerminal).not.toHaveBeenCalled();
});

it("isolates task and run changes even within the same workspace", async () => {
  openChanges("A", null);
  const taskId = usePane.getState().active;
  openChanges("A", "run-a");
  const runId = usePane.getState().active;
  select("B");
  expect(visiblePaneTabs("B")).toEqual([]);
  openChanges("B", null);
  expect(usePane.getState().active).not.toBe(taskId);
  await openBrowser();
  const bActive = usePane.getState().active;
  select("A");
  expect(usePane.getState().active).toBe(runId);
  select("C");
  expect(visiblePaneTabs("C")).toEqual([]);
  select("B");
  expect(usePane.getState().active).toBe(bActive);
  await closeTab(taskId ?? "");
  expect(visiblePaneTabs("A").map((tab) => tab.id)).toEqual([runId]);
  expect(usePane.getState().active).toBe(bActive);
});

it("keeps individual operation previews distinct from cumulative changes and repeated tool IDs in other runs", () => {
  openChanges("A", "first", "/shared/a.ts", "edit");
  const first = usePane.getState().active;
  openChanges("A", "first", "/shared/a.ts", "edit");
  expect(visiblePaneTabs("A")).toHaveLength(1);
  openChanges("A", "second", "/shared/a.ts", "edit");
  expect(usePane.getState().active).not.toBe(first);
  openChanges("A", "first", "/shared/a.ts");
  expect(visiblePaneTabs("A")).toHaveLength(3);
  expect(visiblePaneTabs("A")[0]).toMatchObject({ title: "a.ts", runId: "first", toolCallId: "edit" });
  select("B");
  expect(visiblePaneTabs("B")).toEqual([]);
});

it("routes delayed browser, HTML and terminal opens to their source task without stealing focus", async () => {
  const browserResult = Promise.withResolvers<Result<BrowserState>>();
  const fileResult = Promise.withResolvers<Result<FilePreview>>();
  const terminalResult = Promise.withResolvers<Result<{ id: string; shell: string }>>();
  bridge.createBrowser.mockReturnValueOnce(browserResult.promise);
  bridge.readFilePreview.mockReturnValueOnce(fileResult.promise);
  bridge.createTerminal.mockReturnValueOnce(terminalResult.promise);
  const pendingBrowser = openBrowser();
  const pendingFile = openFile("A", "/shared/page.html");
  const pendingTerminal = openTerminal("A");
  await Promise.resolve();
  select("B");
  await openBrowser();
  const bActive = usePane.getState().active;
  browserResult.resolve(ok(browser("delayed-browser")));
  fileResult.resolve(ok({ ...file, path: "/shared/page.html" }));
  terminalResult.resolve(ok({ id: "delayed-terminal", shell: "zsh" }));
  await Promise.all([pendingBrowser, pendingFile, pendingTerminal]);
  expect(visiblePaneTabs("B")).toHaveLength(1);
  expect(usePane.getState().active).toBe(bActive);
  expect(visiblePaneTabs("A")).toHaveLength(3);
  expect(visiblePaneTabs("A").every((tab) => tab.sessionId === "A")).toBe(true);
  select("A");
  expect(usePane.getState().open).toBe(true);
});

it("updates inactive browser state and terminal output without revealing that task", async () => {
  await openBrowser();
  const id = usePane.getState().active ?? "";
  select("B");
  event({ type: "browser", state: browser(id, "https://example.test/next") });
  event({ type: "terminal", id: "terminal-a", data: "still running" });
  expect(usePane.getState()).toMatchObject({ open: false, active: undefined });
  expect(terminalOutput.get("terminal-a")).toBe("still running");
  select("A");
  expect(visiblePaneTabs("A")[0]).toMatchObject({ state: { url: "https://example.test/next" } });
});

it("closes and reorders only the intended tabs even when selection changes during native cleanup", async () => {
  await openBrowser();
  const aFirst = usePane.getState().active ?? "";
  select("B");
  await openBrowser();
  const bId = usePane.getState().active ?? "";
  select("A");
  await openBrowser();
  const aLast = usePane.getState().active ?? "";
  reorderPaneTab(aLast, aFirst);
  expect(visiblePaneTabs("A").map((tab) => tab.id)).toEqual([aLast, aFirst]);
  reorderPaneTab(aLast, bId);
  expect(visiblePaneTabs("A").map((tab) => tab.id)).toEqual([aLast, aFirst]);
  const closing = Promise.withResolvers<Result<void>>();
  bridge.closeBrowser.mockReturnValueOnce(closing.promise);
  const pending = closeTab(aLast);
  select("B");
  closing.resolve(ok(undefined));
  await pending;
  expect(usePane.getState()).toMatchObject({ open: true, active: bId });
  select("A");
  expect(usePane.getState().active).toBe(aFirst);
  await closeTab(aFirst);
  expect(usePane.getState()).toMatchObject({ open: false, active: undefined });
  expect(visiblePaneTabs("B")).toHaveLength(1);
});

it("does not remove a tab when native cleanup fails", async () => {
  await openBrowser();
  const id = usePane.getState().active ?? "";
  bridge.closeBrowser.mockResolvedValueOnce({
    ok: false,
    error: { code: "storage", message: "close failed" },
  });
  await expect(closeTab(id)).rejects.toThrow("close failed");
  expect(usePane.getState()).toMatchObject({ open: true, active: id });
  expect(visiblePaneTabs("A")).toHaveLength(1);
});

it("retains ordinary panes when a session is archived or omitted from a refreshed list", async () => {
  await openTerminal("A");
  await openBrowser();
  await openFile("A", file.path);
  const tabs = visiblePaneTabs("A");
  const record = useStore.getState().sessions.get("A");
  if (!record) throw new Error("missing session");
  useStore.setState({
    sessions: new Map(useStore.getState().sessions).set("A", { ...record, archivedAt: 1 }),
  });
  const sessions = new Map(useStore.getState().sessions);
  sessions.delete("A");
  useStore.setState({ sessions });
  select("B");
  expect(visiblePaneTabs("A")).toEqual(tabs);
  expect(bridge.closeTerminal).not.toHaveBeenCalled();
  expect(bridge.closeBrowser).not.toHaveBeenCalled();
  useStore.setState({ sessions: new Map(sessions).set("A", record) });
  select("A");
  expect(visiblePaneTabs("A")).toEqual(tabs);
});

it("retains a child pane's owner across restoration, refresh, navigation and permanent deletion", async () => {
  const parent = useStore.getState().sessions.get("A");
  if (!parent) throw new Error("missing session");
  useStore.setState({
    sessions: new Map(useStore.getState().sessions).set("child-a", {
      ...parent,
      id: "child-a",
      parentSessionId: "A",
    }),
  });
  await openFile("child-a", file.path);
  const fileId = usePane.getState().active;
  const sessions = new Map(useStore.getState().sessions);
  sessions.delete("A");
  sessions.delete("child-a");
  useStore.setState({ sessions });
  select("B");
  // Restoring reloads the top-level task, not its archived child records.
  useStore.setState({ sessions: new Map(sessions).set("A", parent) });
  select("A");
  expect(visiblePaneTabs("A")).toHaveLength(1);
  await openFile("child-a", file.path);
  expect(visiblePaneTabs("A")).toEqual([
    expect.objectContaining({ id: fileId, ownerSessionId: "A", sessionId: "child-a" }),
  ]);
  bridge.readFilePreview.mockResolvedValueOnce(ok({ ...file, path: "/shared/linked.md" }));
  await openFile("child-a", "/shared/linked.md");
  await openWebLink("http://localhost:3000/", undefined, "child-a");
  const browserId = usePane.getState().active;
  expect(visiblePaneTabs("A")).toHaveLength(3);
  expect(visiblePaneTabs("child-a")).toEqual([]);
  expect(visiblePaneTabs("A").every((tab) => tab.ownerSessionId === "A")).toBe(true);
  useStore.setState({ sessions });
  select("B");
  await deleteSessionWithPanes("A");
  expect(usePane.getState().tabs).toEqual([]);
  expect(bridge.closeBrowser).toHaveBeenCalledExactlyOnceWith(browserId);
});

it.each(["B", undefined])(
  "uses live child ownership instead of stale retained tabs: %s",
  async (parentId) => {
    const parent = useStore.getState().sessions.get("A");
    if (!parent) throw new Error("missing session");
    const child = { ...parent, id: "child-a", parentSessionId: "A" };
    useStore.setState({ sessions: new Map(useStore.getState().sessions).set(child.id, child) });
    await openFile(child.id, file.path);
    useStore.setState({
      sessions: new Map(useStore.getState().sessions).set(child.id, {
        ...child,
        parentSessionId: parentId,
      }),
    });
    const owner = parentId ?? child.id;
    select(owner);
    await openFile(child.id, file.path);
    await openWebLink("http://localhost:3000/", undefined, child.id);
    expect(visiblePaneTabs(owner)).toHaveLength(2);
    expect(visiblePaneTabs("A")).toEqual([]);
    expect(visiblePaneTabs(owner).every((tab) => tab.ownerSessionId === owner)).toBe(true);
  },
);

it("closes permanently deleted task panes and their retained child panes without touching another task", async () => {
  await openTerminal("A");
  const terminalId = visiblePaneTabs("A")[0].id;
  event({ type: "terminal", id: terminalId, data: "retained output" });
  await openBrowser();
  const browserId = usePane.getState().active;
  await openFile("A", file.path);
  const record = useStore.getState().sessions.get("A");
  if (!record) throw new Error("missing session");
  useStore.setState({
    sessions: new Map(useStore.getState().sessions).set("child-a", {
      ...record,
      id: "child-a",
      parentSessionId: "A",
    }),
  });
  await openBrowser("https://example.test/child", "child-a");
  const childBrowserId = usePane.getState().active;
  const sessions = new Map(useStore.getState().sessions);
  sessions.delete("A");
  sessions.delete("child-a");
  useStore.setState({ sessions });
  select("B");
  await openBrowser();
  const otherTabs = visiblePaneTabs("B");
  await deleteSessionWithPanes("A");
  expect(bridge.deleteSession).toHaveBeenCalledWith("A");
  expect(bridge.closeTerminal).toHaveBeenCalledExactlyOnceWith(terminalId);
  expect(bridge.closeBrowser).toHaveBeenCalledTimes(2);
  expect(bridge.closeBrowser).toHaveBeenCalledWith(browserId);
  expect(bridge.closeBrowser).toHaveBeenCalledWith(childBrowserId);
  expect(visiblePaneTabs("A")).toEqual([]);
  expect(usePane.getState().tabs).toEqual(otherTabs);
  expect(terminalOutput.has(terminalId)).toBe(false);
  expect(usePane.getState().preferences.has("A")).toBe(false);
  expect(usePane.getState().active).toBe(otherTabs[0].id);
});

it("does not close task panes when permanent deletion fails", async () => {
  await openTerminal("A");
  await openBrowser();
  const tabs = visiblePaneTabs("A");
  bridge.deleteSession.mockResolvedValueOnce({
    ok: false,
    error: { code: "storage", message: "delete failed" },
  });
  await expect(deleteSessionWithPanes("A")).rejects.toThrow("delete failed");
  expect(visiblePaneTabs("A")).toEqual(tabs);
  expect(usePane.getState().deletedSessionIds.has("A")).toBe(false);
  expect(bridge.closeTerminal).not.toHaveBeenCalled();
  expect(bridge.closeBrowser).not.toHaveBeenCalled();
});

it("cleans side-chat and terminal panes when the deleted child already returns not_found", async () => {
  await openTerminal("A");
  usePane.setState({
    tabs: [
      ...usePane.getState().tabs,
      {
        type: "side-chat",
        id: "side-chat:deleted-child",
        sessionId: "A",
        childSessionId: "deleted-child",
        title: "Side chat",
        ordinal: 1,
      },
    ],
  });
  bridge.closeSideChat.mockResolvedValueOnce({
    ok: false,
    error: { code: "not_found", message: "child already deleted" },
  });
  await deleteSessionWithPanes("A");
  expect(bridge.closeSideChat).toHaveBeenCalledExactlyOnceWith("deleted-child");
  expect(bridge.closeTerminal).toHaveBeenCalledTimes(1);
  expect(visiblePaneTabs("A")).toEqual([]);
  expect(report).not.toHaveBeenCalled();
});

it("reports cleanup failures separately after successful deletion and still closes other panes", async () => {
  await openTerminal("A");
  await openBrowser();
  bridge.closeBrowser.mockResolvedValueOnce({
    ok: false,
    error: { code: "storage", message: "native close failed" },
  });
  await expect(deleteSessionWithPanes("A")).resolves.toBeUndefined();
  expect(bridge.closeTerminal).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("任务已删除") }),
  );
});

it("disposes native panes whose creation finishes after their task is deleted", async () => {
  const browserResult = Promise.withResolvers<Result<BrowserState>>();
  const terminalResult = Promise.withResolvers<Result<{ id: string; shell: string }>>();
  const fileResult = Promise.withResolvers<Result<FilePreview>>();
  bridge.createBrowser.mockReturnValueOnce(browserResult.promise);
  bridge.createTerminal.mockReturnValueOnce(terminalResult.promise);
  bridge.readFilePreview.mockReturnValueOnce(fileResult.promise);
  const pendingBrowser = openBrowser();
  const pendingTerminal = openTerminal("A");
  const pendingFile = openFile("A", "/shared/page.html");
  await Promise.resolve();
  expect(bridge.createTerminal).toHaveBeenCalledWith("A");
  await deleteSessionWithPanes("A");
  browserResult.resolve(ok(browser("late-browser")));
  terminalResult.resolve(ok({ id: "late-terminal", shell: "zsh" }));
  fileResult.resolve(ok({ ...file, path: "/shared/page.html" }));
  await Promise.all([pendingBrowser, pendingTerminal, pendingFile]);
  expect(bridge.closeBrowser).toHaveBeenCalledExactlyOnceWith("late-browser");
  expect(bridge.closeTerminal).toHaveBeenCalledExactlyOnceWith("late-terminal");
  expect(bridge.createBrowser).toHaveBeenCalledTimes(1);
  expect(visiblePaneTabs("A")).toEqual([]);
});

it("opens streamed file operations from their parameters without reading an unfinished file", async () => {
  useStore.setState({
    views: new Map([
      [
        "A",
        {
          sessionId: "A",
          title: "A",
          seq: 1,
          runs: [
            {
              runId: "writing",
              status: "running",
              userMessage: "write",
              startedAt: 0,
              finalAnswerBlockIds: [],
              orderedBlocks: [
                {
                  type: "tool",
                  id: "write",
                  messageId: "assistant",
                  toolCallId: "write",
                  name: "write",
                  status: "preparing",
                  argsText: '{"path":"page.html","content":"partial',
                  output: "",
                },
              ],
            },
          ],
        },
      ],
    ]),
  });
  await openFile("A", "/shared/page.html");
  expect(bridge.readFilePreview).not.toHaveBeenCalled();
  expect(bridge.createBrowser).not.toHaveBeenCalled();
  expect(visiblePaneTabs("A")).toEqual([
    expect.objectContaining({
      type: "changes",
      runId: "writing",
      toolCallId: "write",
      path: "page.html",
    }),
  ]);
  await openFile("B", "/shared/page.html");
  expect(bridge.readFilePreview).toHaveBeenCalledWith("B", "/shared/page.html", undefined);
});

it("still reports missing files when there is no pending matching write", async () => {
  bridge.readFilePreview.mockResolvedValueOnce({
    ok: false,
    error: {
      code: "not_found",
      message: "文件不存在",
    },
  });
  await expect(openFile("A", "/shared/missing.html")).rejects.toThrow("文件不存在");
  expect(visiblePaneTabs("A")).toHaveLength(0);
});
