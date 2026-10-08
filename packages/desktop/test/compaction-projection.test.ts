import { SessionManager } from "ZPI-coding-agent";
import { emptySession, reduceSession } from "ZPI-ui/projection";
import { expect, it } from "vitest";
import { projectEvent, restoreView } from "../src/main/projection.ts";

it("restores compaction lifecycle and turns unfinished operations into interrupted dividers", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("ZPI.run", { phase: "start", runId: "r", text: "/compact", startedAt: 1 });
  manager.appendCustomEntry("ZPI.compaction", {
    runId: "r",
    id: "c",
    status: "running",
    origin: "manual",
  });
  expect(restoreView("s", "task", manager.getEntries()).runs[0]).toMatchObject({
    kind: "compact",
    status: "interrupted",
    compactions: [{ id: "c", status: "interrupted", origin: "manual" }],
  });
  manager.appendCustomEntry("ZPI.compaction", {
    runId: "r",
    id: "c",
    status: "completed",
    origin: "manual",
  });
  manager.appendCustomEntry("ZPI.run", { phase: "end", runId: "r", status: "completed", endedAt: 2 });
  expect(restoreView("s", "task", manager.getEntries()).runs[0].compactions).toEqual([
    { id: "c", status: "completed", origin: "manual", afterBlockId: undefined, error: undefined },
  ]);
});

it("restores old manual and automatic compaction notices as timeline markers", () => {
  for (const [text, notice, origin] of [
    ["/compact keep decisions", "上下文已压缩；完整历史保留，下一次请求使用摘要和最近回合。", "manual"],
    ["continue", "上下文接近容量，已自动压缩。", "auto"],
  ]) {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("ZPI.run", { phase: "start", runId: "r", text, startedAt: 1 });
    manager.appendCustomEntry("ZPI.notice", { runId: "r", text: notice });
    manager.appendCustomEntry("ZPI.run", { phase: "end", runId: "r", status: "completed", endedAt: 2 });
    const run = restoreView("s", "task", manager.getEntries()).runs[0];
    expect(run.notice).toBeUndefined();
    expect(run.compactions).toMatchObject([{ status: "completed", origin }]);
  }
});

it("keeps automatic compaction at its stream position and updates a single marker", () => {
  let view = emptySession("s");
  let seq = 0;
  const apply = (event: Parameters<typeof reduceSession>[1]["event"]) => {
    view = reduceSession(view, { sessionId: "s", runId: "r", seq: ++seq, event });
  };
  apply({ type: "started", text: "continue", startedAt: 1, modelLabel: "fake" });
  apply({ type: "block_start", messageId: "m", contentIndex: 0, kind: "text" });
  apply({ type: "compaction", id: "c", status: "running", origin: "auto" });
  apply({ type: "block_start", messageId: "next", contentIndex: 0, kind: "text" });
  apply({ type: "compaction", id: "c", status: "completed", origin: "auto" });
  expect(view.runs[0].compactions).toEqual([
    { id: "c", status: "completed", origin: "auto", afterBlockId: "m:0", error: undefined },
  ]);
  expect(view.runs[0].kind).toBeUndefined();
  expect(projectEvent({ type: "command_result", message: "上下文已压缩" }, "m")).toBeUndefined();
});
