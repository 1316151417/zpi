import { expect, test, vi } from "vitest";
import { assembleSession, SessionManager } from "zpi-coding-agent";
import { fakeModel } from "../../../tests/fake-server.ts";
import { type TaskBackend, TaskControls } from "../src/main/tasks/controls.ts";

function backend(kind: string, taskId: string): TaskBackend {
  return {
    kind,
    owns: (owner, id) => owner === "owner" && id === taskId,
    output: vi.fn(async () => ({ content: [{ type: "text" as const, text: kind }], details: undefined })),
    stop: vi.fn(async () => ({ content: [{ type: "text" as const, text: "stopped" }], details: undefined })),
  };
}
function tools(backends: TaskBackend[], owner = "owner") {
  return assembleSession({
    builtinTools: [],
    context: () => ({
      cwd: "/tmp",
      model: fakeModel(""),
      sessionManager: SessionManager.inMemory(),
      isIdle: () => true,
      getSystemPrompt: () => "",
    }),
    plugins: [{ id: "test.tasks", version: "1", tools: new TaskControls(backends).tools(owner) }],
  }).activeTools;
}

test("task controls route by ownership even when IDs resemble another backend", async () => {
  const bash = backend("local_bash", "agent-looking-id");
  const agent = backend("local_agent", "bash-looking-id");
  const [output, stop] = tools([bash, agent]);
  await output.execute("output", { task_id: "agent-looking-id", block: "false" });
  expect(bash.output).toHaveBeenCalledWith(
    "owner",
    "output",
    { task_id: "agent-looking-id", block: false, timeout: 30000 },
    undefined,
  );
  expect(agent.output).not.toHaveBeenCalled();
  await stop.execute("stop", { shell_id: "bash-looking-id" });
  expect(agent.stop).toHaveBeenCalledWith("owner", "stop", "bash-looking-id", undefined);
  expect(bash.stop).not.toHaveBeenCalled();
});

test("foreign, unknown and ambiguous task ownership never reaches a backend", async () => {
  const first = backend("first", "task");
  const second = backend("second", "task");
  const [foreignOutput, foreignStop] = tools([first], "stranger");
  await expect(foreignOutput.execute("output", { task_id: "task" })).rejects.toThrow("No task found");
  await expect(foreignStop.execute("stop", { task_id: "task" })).rejects.toThrow("Invalid task ID");
  const [ambiguous] = tools([first, second]);
  await expect(ambiguous.execute("output", { task_id: "task" })).rejects.toThrow("Ambiguous task ownership");
  expect(first.output).not.toHaveBeenCalled();
  expect(first.stop).not.toHaveBeenCalled();
  expect(second.output).not.toHaveBeenCalled();
  expect(() => new TaskControls([first, first])).toThrow("Duplicate task backend");
});

test("invalid or cancelled task operations do not reach a backend", async () => {
  const task = backend("test", "task");
  const [output, stop] = tools([task]);
  await expect(output.execute("output", { task_id: "task", timeout: 600001 })).rejects.toThrow();
  await expect(stop.execute("stop", {})).rejects.toThrow("Missing required parameter");
  const abort = new AbortController();
  abort.abort();
  await expect(output.execute("output", { task_id: "task" }, abort.signal)).rejects.toThrow();
  expect(task.output).not.toHaveBeenCalled();
  expect(task.stop).not.toHaveBeenCalled();
});
