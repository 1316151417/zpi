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
  terminalExited,
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
  terminalExited.clear();
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
  event({ type: "terminal", id: "terminal-a", data: "exited", exited: true });
  expect(terminalExited.has("terminal-a")).toBe(true);
  expect(terminalOutput.get("terminal-a")).toBe("still runningexited");
  select("A");
  expect(visiblePaneTabs("A")[0]).toMatchObject({ state: { url: "https://example.test/next" } });
});

it.each([file.path, "./readme.md", "/shared/readme-link.md"])(
  "keeps the newer file contents and line target when an earlier read of %s finishes last",
  async (path) => {
    const earlier = Promise.withResolvers<Result<FilePreview>>();
    const later = Promise.withResolvers<Result<FilePreview>>();
    bridge.readFilePreview.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise);
    const first = openFile("A", path, { line: 10 });
    const second = openFile("A", file.path, { line: 100 });
    const latest = { ...file, text: "new contents", location: { line: 100 } };
    later.resolve(ok(latest));
    await second;
    earlier.resolve(ok({ ...file, text: "old contents", location: { line: 10 } }));
    await first;
    expect(visiblePaneTabs("A")).toEqual([expect.objectContaining({ type: "file", preview: latest })]);
  },
);

it("closing a file invalidates pending refreshes but allows a later explicit reopen", async () => {
  await openFile("A", file.path);
  const id = usePane.getState().active ?? "";
  const earlier = Promise.withResolvers<Result<FilePreview>>();
  bridge.readFilePreview.mockReturnValueOnce(earlier.promise);
  const refresh = openFile("A", file.path);
  await closeTab(id);
  earlier.resolve(ok({ ...file, text: "late refresh" }));
  await refresh;
  expect(visiblePaneTabs("A")).toEqual([]);
  expect(usePane.getState()).toMatchObject({ open: false, active: undefined });
  await openFile("A", file.path);
  expect(visiblePaneTabs("A")).toHaveLength(1);
  expect(usePane.getState().open).toBe(true);
});

it("closing a file also invalidates an in-flight read through a symlink alias", async () => {
  await openFile("A", file.path);
  const earlier = Promise.withResolvers<Result<FilePreview>>();
  bridge.readFilePreview.mockReturnValueOnce(earlier.promise);
  const opening = openFile("A", "/shared/readme-link.md");
  await closeTab(usePane.getState().active ?? "");
  earlier.resolve(ok(file));
  await opening;
  expect(visiblePaneTabs("A")).toEqual([]);
});

it("ignores a stale file failure and still allows independent file opens", async () => {
  const earlier = Promise.withResolvers<Result<FilePreview>>();
  bridge.readFilePreview.mockReturnValueOnce(earlier.promise);
  const opening = openFile("A", file.path);
  await openFile("A", file.path);
  const other = { ...file, path: "/shared/other.md" };
  bridge.readFilePreview.mockResolvedValueOnce(ok(other));
  await openFile("A", other.path);
  earlier.resolve({ ok: false, error: { code: "not_found", message: "old read failed" } });
  await expect(opening).resolves.toBeUndefined();
  expect(visiblePaneTabs("A")).toHaveLength(2);
  expect(visiblePaneTabs("A")[1]).toMatchObject({ preview: other });
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
  await expect(closeTab(id)).rejects.toMatchObject({
    cause: { code: "storage", message: "close failed" },
  });
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
  await expect(deleteSessionWithPanes("A")).rejects.toMatchObject({
    cause: { code: "storage", message: "delete failed" },
  });
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

it.each(["pdf", "pptx", "docx", "doc", "xlsx", "html", "svg"])(
  "opens %s in the file pane without spawning a browser or external app",
  async (extension) => {
    const kind = extension === "html" || extension === "svg" ? "text" : extension;
    const path = `/shared/document.${extension}`;
    const preview =
      kind === "text" ? { ...file, path } : ({ kind, path, bytes: new Uint8Array([1, 2]) } as FilePreview);
    bridge.readFilePreview.mockResolvedValueOnce(ok(preview));
    await openFile("A", path);
    expect(visiblePaneTabs("A")).toEqual([
      expect.objectContaining({ type: "file", sessionId: "A", preview }),
    ]);
    expect(bridge.createBrowser).not.toHaveBeenCalled();
  },
);

it("names terminals by workspace with per-owner ordinals rather than shell executable", async () => {
  await openTerminal("A");
  await openTerminal("A");
  await openTerminal("B");
  expect(usePane.getState().tabs.map((tab) => tab.title)).toEqual(["shared", "shared 2", "shared"]);
  const first = usePane.getState().tabs[0];
  if (!first) throw new Error("missing terminal tab");
  await closeTab(first.id);
  await openTerminal("A");
  expect(usePane.getState().tabs.at(-1)?.title).toBe("shared");
});

it("keeps native profile metadata on its terminal tab without altering the shell process title", async () => {
  const profile = { fontFamily: "Menlo", fontSize: 15, theme: { green: "#12ab34" } };
  bridge.createTerminal.mockResolvedValueOnce(ok({ id: "native-profile", shell: "zsh", profile }));
  await openTerminal("A");
  expect(usePane.getState().tabs[0]).toMatchObject({
    id: "native-profile",
    title: "shared",
    cwd: "/shared",
    profile,
  });
  expect(bridge.createTerminal).toHaveBeenCalledOnce();
  expect(bridge.closeTerminal).not.toHaveBeenCalled();
});

it.each(["html", "HTM"])(
  "opens explicit Markdown %s links in the browser, after validating the file",
  async (extension) => {
    const path = `/shared/page.${extension}`;
    const location = { fileUrl: `file://${path}?preview=1#intro` };
    bridge.readFilePreview.mockResolvedValueOnce(ok({ ...file, path, location }));
    await openFile("A", path, location, "markdown-link");
    expect(bridge.readFilePreview).toHaveBeenCalledWith("A", path, location);
    expect(bridge.createBrowser).toHaveBeenCalledWith(`file://${path}?preview=1#intro`);
    expect(visiblePaneTabs("A")[0]).toMatchObject({ type: "browser", sessionId: "A", ownerSessionId: "A" });
  },
);

it.each(["/shared/page.html", "/shared/report.pdf"])(
  "keeps source line links and PDF Markdown links in the file pane: %s",
  async (path) => {
    const location = path.endsWith("html") ? { line: 2 } : undefined;
    bridge.readFilePreview.mockResolvedValueOnce(ok({ ...file, path, location }));
    await openFile("A", path, location, "markdown-link");
    expect(visiblePaneTabs("A")[0]).toMatchObject({ type: "file" });
    expect(bridge.createBrowser).not.toHaveBeenCalled();
  },
);

it("deduplicates repeated HTML Markdown opens and does not resurrect a closed browser after a delayed read", async () => {
  const path = "/shared/page.html";
  const url = "file:///shared/page.html";
  bridge.readFilePreview.mockResolvedValueOnce(ok({ ...file, path }));
  bridge.createBrowser.mockResolvedValueOnce(ok(browser("html-browser", url)));
  await openFile("A", path, undefined, "markdown-link");
  bridge.readFilePreview.mockResolvedValueOnce(ok({ ...file, path }));
  await openFile("A", path, undefined, "markdown-link");
  expect(bridge.createBrowser).toHaveBeenCalledOnce();
  const delayed = Promise.withResolvers<Result<FilePreview>>();
  bridge.readFilePreview.mockReturnValueOnce(delayed.promise);
  const pending = openFile("A", path, undefined, "markdown-link");
  await closeTab("html-browser");
  delayed.resolve(ok({ ...file, path }));
  await pending;
  expect(visiblePaneTabs("A")).toEqual([]);
  expect(bridge.createBrowser).toHaveBeenCalledOnce();
});

it("discards an older native HTML browser creation after a newer source open", async () => {
  const path = "/shared/page.html";
  const delayed = Promise.withResolvers<Result<BrowserState>>();
  bridge.readFilePreview.mockResolvedValueOnce(ok({ ...file, path }));
  bridge.createBrowser.mockReturnValueOnce(delayed.promise);
  const pending = openFile("A", path, undefined, "markdown-link");
  await vi.waitFor(() => expect(bridge.createBrowser).toHaveBeenCalledOnce());
  bridge.readFilePreview.mockResolvedValueOnce(ok({ ...file, path }));
  await openFile("A", path);
  delayed.resolve(ok(browser("stale-html", "file:///shared/page.html")));
  await pending;
  expect(bridge.closeBrowser).toHaveBeenCalledWith("stale-html");
  expect(visiblePaneTabs("A")).toHaveLength(1);
  expect(visiblePaneTabs("A")[0].type).toBe("file");
});

it("keeps an auxiliary chat HTML browser owned by its parent when selection changes", async () => {
  useStore.setState({
    sessions: new Map([
      ...useStore.getState().sessions,
      [
        "side",
        {
          id: "side",
          title: "side",
          cwd: "/shared",
          parentSessionId: "A",
          projectId: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    ]),
  });
  const delayed = Promise.withResolvers<Result<BrowserState>>();
  bridge.readFilePreview.mockResolvedValueOnce(ok({ ...file, path: "/shared/page.html" }));
  bridge.createBrowser.mockReturnValueOnce(delayed.promise);
  const pending = openFile("side", "/shared/page.html", undefined, "markdown-link");
  await vi.waitFor(() => expect(bridge.createBrowser).toHaveBeenCalledOnce());
  select("B");
  delayed.resolve(ok(browser("side-html", "file:///shared/page.html")));
  await pending;
  expect(visiblePaneTabs("A")[0]).toMatchObject({ type: "browser", sessionId: "side", ownerSessionId: "A" });
  expect(visiblePaneTabs("B")).toEqual([]);
  expect(usePane.getState().open).toBe(false);
});

it("does not create an HTML browser when validation fails", async () => {
  bridge.readFilePreview.mockResolvedValueOnce({
    ok: false,
    error: { code: "not_found", message: "missing" },
  });
  await expect(openFile("A", "/shared/page.html", undefined, "markdown-link")).rejects.toMatchObject({
    cause: { code: "not_found", message: "missing" },
  });
  expect(bridge.createBrowser).not.toHaveBeenCalled();
});

it.each([undefined, "file:A:/shared/old.html"])(
  "binds the current file key when reusing a browser with previous key %s",
  async (fileKey) => {
    const path = "/shared/page.html",
      url = "file:///shared/page.html";
    usePane.setState({
      tabs: [
        {
          type: "browser",
          id: "existing",
          title: "browser",
          sessionId: "A",
          ownerSessionId: "A",
          state: browser("existing", url),
          fileKey,
        },
      ],
    });
    bridge.readFilePreview.mockResolvedValueOnce(ok({ ...file, path }));
    await openFile("A", path, undefined, "markdown-link");
    expect(bridge.createBrowser).not.toHaveBeenCalled();
    expect(visiblePaneTabs("A")[0]).toMatchObject({ fileKey: "file:A:/shared/page.html" });
    const delayed = Promise.withResolvers<Result<FilePreview>>();
    bridge.readFilePreview.mockReturnValueOnce(delayed.promise);
    const pending = openFile("A", path, undefined, "markdown-link");
    await closeTab("existing");
    delayed.resolve(ok({ ...file, path }));
    await pending;
    expect(visiblePaneTabs("A")).toEqual([]);
    expect(bridge.createBrowser).not.toHaveBeenCalled();
  },
);
