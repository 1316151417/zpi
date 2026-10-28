import { expect, it } from "vitest";
import { emptyAssistant } from "zpi-ai";
import { SessionManager } from "zpi-coding-agent";
import { fakeModel } from "../../../tests/fake-server.ts";
import { projectEvent, restoreView } from "../src/main/projection.ts";

it("projects waiting and recovery boundaries without losing their timestamps", () => {
  const status = { phase: "first_response" as const, startedAt: 12_345 };
  expect(projectEvent({ type: "model_wait", status }, "m")).toEqual({ type: "model_wait", status });
  expect(projectEvent({ type: "model_wait", status: null }, "m")).toEqual({
    type: "model_wait",
    status: null,
  });
});

it("restores retried replies as interrupted while preserving successful tools and the final answer", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("zpi.run", { phase: "start", runId: "r", text: "answer", startedAt: 1 });
  const model = fakeModel("");
  manager.appendMessage({
    ...emptyAssistant(model),
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "write", name: "write", arguments: { path: "once.txt" } }],
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "write",
    toolName: "write",
    content: [{ type: "text", text: "written once" }],
    isError: false,
    timestamp: 2,
  });
  for (let attempt = 0; attempt < 2; attempt++)
    manager.appendMessage({
      ...emptyAssistant(model),
      stopReason: "error",
      errorMessage: "overloaded",
      content: [{ type: "text", text: `partial ${attempt}` }],
    });
  manager.appendMessage({ ...emptyAssistant(model), content: [{ type: "text", text: "final" }] });
  manager.appendCustomEntry("zpi.run", { phase: "end", runId: "r", status: "completed", endedAt: 10 });
  const run = restoreView("s", "task", manager.getEntries()).runs[0];
  expect(run.orderedBlocks).toMatchObject([
    { type: "tool", status: "completed", output: "written once" },
    { type: "text", text: "partial 0", interrupted: true },
    { type: "text", text: "partial 1", interrupted: true },
    { type: "text", text: "final" },
  ]);
  expect(run.finalAnswerBlockIds).toEqual([run.orderedBlocks[3].id]);
  expect(run.error).toBeUndefined();
});
