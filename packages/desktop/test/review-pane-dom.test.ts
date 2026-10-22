import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ReviewPane } from "../src/renderer/ReviewPane.tsx";
import type { DesktopBridge, DiffItem } from "../src/shared/bridge.ts";
import type { ReviewSource } from "../src/shared/review.ts";

vi.mock("../src/renderer/use-workspace.ts", () => ({ useWorkspace: () => ({ cwd: "/project" }) }));
vi.mock("../src/renderer/store.ts", () => ({ report: vi.fn() }));
vi.mock("../src/renderer/pane-store.ts", () => ({
  openFile: vi.fn(),
  openFileManager: vi.fn(),
  paneTask: vi.fn(),
}));
vi.mock("../src/renderer/workspace-file-tree/FileTreeRow.tsx", () => ({
  fileManagerLabel: "在 Finder 中打开",
}));
vi.mock("zpi-ui", async (original) => ({
  ...(await original<typeof import("zpi-ui")>()),
  DiffView: ({ entries }: { entries: DiffItem[] }) =>
    createElement("div", { "data-review-files": "" }, entries.map((entry) => entry.path).join(",")),
}));

const getReview = vi.fn<DesktopBridge["getReview"]>();
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getReview.mockReset();
  Object.defineProperty(window, "zpi", { configurable: true, value: { getReview, onEvent: () => () => {} } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(source: ReviewSource, visible = true) {
  await act(async () =>
    root.render(
      createElement(ReviewPane, { sessionId: "session", visible, source, onSourceChange: vi.fn() }),
    ),
  );
}
const entry = (path: string): DiffItem => ({ id: path, path, status: "modified", area: "" });

test("hides old-source files immediately and ignores their late responses", async () => {
  let old!: (value: Awaited<ReturnType<DesktopBridge["getReview"]>>) => void;
  let latest!: typeof old;
  getReview
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          latest = resolve;
        }),
    );
  await render("unstaged", false);
  expect(getReview).not.toHaveBeenCalled();
  await render("unstaged");
  await render("staged");
  await act(async () => old({ ok: true, value: { entries: [entry("old.txt")], isRepository: true } }));
  expect(container.textContent).not.toContain("old.txt");
  await act(async () => latest({ ok: true, value: { entries: [entry("new.txt")], isRepository: true } }));
  expect(container.textContent).toContain("new.txt");
  getReview.mockResolvedValue({ ok: true, value: { entries: [], isRepository: false } });
  await render("last-turn");
  expect(container.textContent).not.toContain("new.txt");
  expect(container.textContent).toContain("当前任务还没有上一轮文件改动");
});

test("shows a Git failure and lets refresh retry without leaving the selected source", async () => {
  getReview
    .mockRejectedValueOnce(new Error("git timed out"))
    .mockResolvedValueOnce({ ok: true, value: { entries: [entry("retry.txt")], isRepository: true } });
  await render("branch");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("超时");
  await act(async () => container.querySelector<HTMLButtonElement>(".review-refresh")?.click());
  expect(getReview.mock.calls).toEqual([
    ["session", "branch"],
    ["session", "branch"],
  ]);
  expect(container.textContent).toContain("retry.txt");
});
