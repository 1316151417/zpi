import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  activatePaneTab,
  closeTab,
  listenPanes,
  openBrowser,
  openChanges,
  openFile,
  openTerminal,
  reorderPaneTab,
  setPaneOpen,
  terminalOutput,
  usePane,
  visiblePaneTabs,
} from "../src/renderer/pane-store.ts";
import { useStore } from "../src/renderer/store.ts";
import type { BrowserState, FilePreview, PaneEvent, Result } from "../src/shared/bridge.ts";

vi.mock("../src/renderer/store.ts", async () => {
  const { create } = await import("zustand");
  return {
    useStore: create(() => ({ selected: undefined, sessions: new Map(), projects: [] })),
    report: vi.fn(),
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
};
function select(selected: string | undefined) {
  useStore.setState({ selected });
}
beforeEach(() => {
  vi.clearAllMocks();
  serial = 0;
  vi.stubGlobal("window", { ZPI: bridge });
  usePane.setState({ open: false, active: undefined, tabs: [], preferences: new Map() });
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
          updatedAt: 0,
        },
      ]),
    ),
    projects: [],
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
