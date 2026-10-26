import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangedFiles } from "../src/components/ChangedFiles.tsx";
import type { FileChangeSummary, RunView } from "../src/types.ts";

let container: HTMLDivElement;
let root: Root;
const run: RunView = {
  runId: "r",
  status: "completed",
  userMessage: "create then edit",
  startedAt: 1,
  endedAt: 2,
  finalAnswerBlockIds: [],
  orderedBlocks: [
    { additions: 5, deletions: 0 },
    { additions: 0, deletions: 4 },
  ].map((stats, index) => ({
    id: `tool-${index}`,
    messageId: "m",
    type: "tool",
    toolCallId: `call-${index}`,
    name: index ? "edit" : "write",
    argsText: "{}",
    status: "completed",
    output: "",
    fileChange: { path: "/project/file.txt", ...stats },
  })),
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("replaces operation counts with the net snapshot result and retains review navigation", async () => {
  const pending = Promise.withResolvers<FileChangeSummary[]>();
  const readFileChanges = vi.fn(() => pending.promise);
  const onChanges = vi.fn();
  await act(async () =>
    root.render(createElement(ChangedFiles, { run, sessionId: "s", readFileChanges, onChanges })),
  );
  expect(readFileChanges).toHaveBeenCalledExactlyOnceWith("s", "r");
  expect(container.textContent).toContain("行数未完整统计");
  expect(container.textContent).not.toContain("+5");
  await act(async () => pending.resolve([{ path: "/project/file.txt", additions: 1, deletions: 0 }]));
  expect(container.querySelector(".changed-files-totals")?.textContent).toBe("+1-0");
  expect(container.textContent).not.toContain("-4");
  container.querySelector<HTMLButtonElement>(".changed-file-review")?.click();
  expect(onChanges).toHaveBeenCalledWith("r", "/project/file.txt");
});

it("removes the card when the final snapshots have no net changes", async () => {
  await act(async () =>
    root.render(
      createElement(ChangedFiles, {
        run,
        sessionId: "s",
        readFileChanges: async () => [],
      }),
    ),
  );
  expect(container.textContent).toBe("");
});

it("ignores late results from another session and keeps missing snapshot counts unknown", async () => {
  const pending = Promise.withResolvers<FileChangeSummary[]>();
  const readFileChanges = vi.fn((id: string) =>
    id === "old" ? pending.promise : Promise.reject(new Error("missing snapshots")),
  );
  await act(async () => root.render(createElement(ChangedFiles, { run, sessionId: "old", readFileChanges })));
  await act(async () => root.render(createElement(ChangedFiles, { run, sessionId: "new", readFileChanges })));
  await act(async () => pending.resolve([{ path: "/old/secret.txt", additions: 99, deletions: 0 }]));
  expect(container.textContent).toContain("file.txt");
  expect(container.textContent).toContain("行数未完整统计");
  expect(container.textContent).not.toContain("secret.txt");
  expect(container.textContent).not.toContain("+5");
  expect(container.textContent).not.toContain("+99");
});
