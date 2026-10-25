import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deferred } from "../../../tests/fake-server.ts";
import { useWorkspaceFileTreeData } from "../src/renderer/workspace-file-tree/use-tree-data.ts";
import type { WorkspaceDirectoryEntry } from "../src/shared/workspace-files.ts";

vi.mock("../src/renderer/workspace-file-tree/use-tree-watchers.ts", () => ({
  useWorkspaceFileTreeWatchers: () => {},
}));
let root: Root;
let container: HTMLDivElement;
let data: ReturnType<typeof useWorkspaceFileTreeData>;
const readDirectory = vi.fn();
function Probe() {
  data = useWorkspaceFileTreeData({ workspacePath: "/repo", sessionId: "s" });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  readDirectory.mockReset();
  Object.defineProperty(window, "zpi", {
    configurable: true,
    value: {
      readWorkspaceDirectory: readDirectory,
      workspaceGitStatus: async () => ({
        ok: true,
        value: {
          summary: { isGitAvailable: true, isRepository: false },
          stagedChanges: [],
          unstagedChanges: [],
        },
      }),
      ignoredWorkspacePaths: async () => ({ ok: true, value: [] }),
    },
  });
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

test("timeout releases superseded expansion loading without letting stale readers clear a newer load", async () => {
  const first = deferred<{ ok: true; value: WorkspaceDirectoryEntry[] }>();
  const refresh = deferred<Awaited<typeof first.promise>>();
  const latest = deferred<Awaited<typeof first.promise>>();
  readDirectory
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(refresh.promise)
    .mockReturnValueOnce(latest.promise);
  await act(async () => root.render(createElement(Probe)));
  expect(data.loadingDirectoryPaths.has("/repo")).toBe(true);
  let refreshing!: Promise<void>;
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await act(async () => {
      refreshing = data.refreshLoadedDirectories();
      await vi.advanceTimersByTimeAsync(15_001);
      await refreshing;
    });
    expect(data.loadingDirectoryPaths.has("/repo")).toBe(false);
    expect(data.errorByDirectory.get("/repo")?.message).toContain("timed out");
    let loading!: ReturnType<typeof data.loadDirectory>;
    await act(async () => {
      loading = data.loadDirectory("/repo", 0);
    });
    expect(readDirectory).toHaveBeenCalledTimes(3);
    expect(data.loadingDirectoryPaths.has("/repo")).toBe(true);
    await act(async () => {
      first.resolve({ ok: true, value: [] });
      refresh.resolve({ ok: true, value: [] });
    });
    expect(data.loadingDirectoryPaths.has("/repo")).toBe(true);
    await act(async () => {
      latest.resolve({ ok: true, value: [] });
      await loading;
    });
    expect(data.loadingDirectoryPaths.has("/repo")).toBe(false);
  } finally {
    warning.mockRestore();
  }
});
