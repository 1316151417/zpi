import { afterEach, expect, test, vi } from "vitest";
import { SessionManager } from "zpi-coding-agent";
import type { SubagentTask } from "zpi-ui";
import { deferred, fakeModel } from "../../../tests/fake-server.ts";
import { SubagentProfiles } from "../src/main/plugins/subagents/profiles.ts";
import { SubagentPlugin } from "../src/main/plugins/subagents/runtime.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  const profiles = new SubagentProfiles("/unused");
  vi.spyOn(profiles, "list").mockReturnValue({
    agents: [
      {
        id: "general-purpose",
        name: "general-purpose",
        description: "General",
        systemPrompt: "Work",
        color: "blue",
        injectAgentsMd: true,
        scope: "built-in",
        enabled: true,
      },
    ],
    diagnostics: [],
  });
  const turns = new Map<string, ReturnType<typeof deferred<void>>>();
  let child = 0;
  const port: ConstructorParameters<typeof SubagentPlugin>[1] = {
    cwd: () => "/workspace",
    selection: () => ({ provider: "test", modelId: "test", reasoning: "none" }),
    create: vi.fn(async () => `child-${++child}`),
    run: vi.fn(async (id) => {
      const turn = deferred();
      turns.set(id, turn);
      await turn.promise;
      const task = plugin.taskForChild(id) as SubagentTask;
      if (task.status !== "aborted")
        plugin.update(task.agentId, { status: "completed", result: "findings", endedAt: Date.now() });
    }),
    steer: vi.fn(() => true),
    stop: vi.fn(async (id) => {
      turns.get(id)?.resolve();
    }),
    publish: vi.fn(),
    notify: vi.fn(async () => {}),
  };
  const plugin = new SubagentPlugin(profiles, port);
  plugin.prepare("parent");
  const invoke = (name: string, params: unknown, signal?: AbortSignal, parent = "parent") => {
    const tool = plugin.tools(parent).find((tool) => tool.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.execute("call", params, signal, undefined, {
      cwd: "/workspace",
      model: fakeModel(""),
      sessionManager: SessionManager.inMemory(),
      isIdle: () => false,
      getSystemPrompt: () => "",
    });
  };
  const launch = async () => {
    await invoke("Agent", { description: "Inspect", prompt: "Search", run_in_background: true });
    return plugin.list("parent").at(-1) as SubagentTask;
  };
  return { plugin, port, turns, invoke, launch };
}

test("TaskOutput supports nonblocking reads, bounded waits, terminal results and parent isolation", async () => {
  const f = fixture();
  const task = await f.launch();
  expect((await f.invoke("TaskOutput", { task_id: task.agentId, block: false })).details).toMatchObject({
    retrieval_status: "not_ready",
  });
  expect((await f.invoke("TaskOutput", { task_id: task.agentId, timeout: 0 })).details).toMatchObject({
    retrieval_status: "timeout",
  });
  await expect(f.invoke("TaskOutput", { task_id: task.agentId }, undefined, "other")).rejects.toThrow(
    "不属于当前会话",
  );
  await expect(f.invoke("TaskOutput", { task_id: task.agentId, timeout: 600001 })).rejects.toThrow(
    "参数无效",
  );
  const output = f.invoke("TaskOutput", { task_id: task.agentId });
  f.turns.get(task.childSessionId)?.resolve();
  expect((await output).details).toMatchObject({
    retrieval_status: "success",
    task: { output: "findings", status: "completed", task_type: "local_agent" },
  });
  await Promise.resolve();
  expect(f.port.notify).not.toHaveBeenCalled();
  expect((await f.invoke("TaskOutput", { task_id: task.agentId })).content).toEqual([
    { type: "text", text: expect.stringContaining("<output>\nfindings\n</output>") },
  ]);
  await f.plugin.close();
});

test("TaskOutput timeout and cancellation clean up event waiters without stopping the child", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const task = await f.launch();
  const timed = f.invoke("TaskOutput", { task_id: task.agentId, timeout: 50 });
  await vi.advanceTimersByTimeAsync(50);
  expect((await timed).details).toMatchObject({ retrieval_status: "timeout" });
  const controller = new AbortController();
  const waiting = f.invoke("TaskOutput", { task_id: task.agentId }, controller.signal);
  const rejected = expect(waiting).rejects.toThrow("cancelled wait");
  controller.abort(new Error("cancelled wait"));
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  expect(f.plugin.list("parent")[0].status).toBe("running");
  await f.plugin.close();
  expect(f.port.notify).not.toHaveBeenCalled();
});

test("concurrent stops drain once, clear waiting state and reject guidance until stopped", async () => {
  const f = fixture();
  const task = await f.launch();
  f.plugin.update(task.agentId, { waitingForInput: true });
  const stopping = f.plugin.stop("parent", task.agentId);
  const again = f.plugin.stop("parent", task.agentId);
  await expect(
    f.invoke("SendMessage", { to: task.agentId, summary: "Continue", message: "Next" }),
  ).rejects.toThrow("正在停止");
  await Promise.all([stopping, again]);
  expect(f.port.stop).toHaveBeenCalledTimes(1);
  expect(f.plugin.list("parent")[0]).toMatchObject({ status: "aborted", waitingForInput: false });
  expect((await f.invoke("TaskOutput", { task_id: task.agentId })).details).toMatchObject({
    retrieval_status: "success",
    task: { status: "aborted" },
  });
});

test("a queued resume is immediately running and parent cancellation prevents it from starting", async () => {
  const f = fixture();
  const delivery = deferred();
  vi.mocked(f.port.notify).mockImplementation(() => delivery.promise);
  const task = await f.launch();
  f.turns.get(task.childSessionId)?.resolve();
  await vi.waitFor(() => expect(f.port.notify).toHaveBeenCalledTimes(1));
  await f.invoke("SendMessage", { to: task.agentId, summary: "Follow up", message: "Continue" });
  expect(f.plugin.list("parent")[0].status).toBe("running");
  const stop = f.plugin.stopAll("parent");
  delivery.resolve();
  await stop;
  expect(f.port.run).toHaveBeenCalledTimes(1);
  expect(f.plugin.list("parent")[0].status).toBe("aborted");
});

test("closing during creation never starts an orphan child", async () => {
  const f = fixture();
  const creating = deferred();
  vi.mocked(f.port.create).mockImplementation(async () => {
    await creating.promise;
    return "late-child";
  });
  const launch = f.launch();
  await f.plugin.close();
  creating.resolve();
  await expect(launch).rejects.toThrow("正在关闭");
  expect(f.port.run).not.toHaveBeenCalled();
  expect(f.plugin.list("parent")[0].status).toBe("aborted");
});

test("finishing an earlier notification does not suppress the resumed turn's result", async () => {
  const f = fixture();
  const delivery = deferred();
  vi.mocked(f.port.notify).mockImplementationOnce(() => delivery.promise);
  const task = await f.launch();
  f.turns.get(task.childSessionId)?.resolve();
  await vi.waitFor(() => expect(f.port.notify).toHaveBeenCalledTimes(1));
  await f.invoke("SendMessage", { to: task.agentId, summary: "Follow up", message: "Continue" });
  delivery.resolve();
  await vi.waitFor(() => expect(f.port.run).toHaveBeenCalledTimes(2));
  f.turns.get(task.childSessionId)?.resolve();
  await vi.waitFor(() => expect(f.port.notify).toHaveBeenCalledTimes(2));
  await f.plugin.close();
});

test("failed and restored interrupted tasks expose status and error without transcript replay", async () => {
  const f = fixture();
  vi.mocked(f.port.run).mockRejectedValueOnce(new Error("provider unavailable"));
  const task = await f.launch();
  const output = await f.invoke("TaskOutput", { task_id: task.agentId });
  expect(output.details).toMatchObject({
    retrieval_status: "success",
    task: { status: "error", error: "Error: provider unavailable" },
  });
  f.plugin.restore({ ...task, agentId: "restored", childSessionId: "restored-child", status: "running" });
  expect((await f.invoke("TaskOutput", { task_id: "restored" })).details).toMatchObject({
    task: { status: "interrupted" },
  });
  await f.plugin.close();
});

test("identical progress updates do not persist or publish redundant snapshots", async () => {
  const f = fixture();
  const task = await f.launch();
  vi.mocked(f.port.publish).mockClear();
  f.plugin.update(task.agentId, { modelLabel: task.modelLabel });
  expect(f.port.publish).not.toHaveBeenCalled();
  f.plugin.update(task.agentId, { latestActivity: "read · file.ts" });
  f.plugin.update(task.agentId, { latestActivity: "read · file.ts" });
  expect(f.port.publish).toHaveBeenCalledTimes(1);
  await f.plugin.close();
});

test("a failed terminal publication cannot skip or duplicate runtime cancellation", async () => {
  const f = fixture();
  const task = await f.launch();
  vi.mocked(f.port.publish).mockImplementation(() => {
    throw new Error("storage: terminal publication failed");
  });
  const first = f.plugin.stop("parent", task.agentId);
  const second = f.plugin.stop("parent", task.agentId);
  await expect(first).rejects.toThrow("terminal publication failed");
  await expect(second).rejects.toThrow("terminal publication failed");
  expect(f.port.stop).toHaveBeenCalledTimes(1);
  expect(f.plugin.list("parent")[0].status).toBe("aborted");
  await f.plugin.close();
  expect(f.port.stop).toHaveBeenCalledTimes(1);
});

test("failed runtime cancellation remains retryable and concurrent retries share one drain", async () => {
  const f = fixture();
  const task = await f.launch();
  const actualStop = f.port.stop;
  vi.mocked(f.port.stop).mockRejectedValueOnce(new Error("process cancellation failed"));
  await expect(f.plugin.stop("parent", task.agentId)).rejects.toThrow("process cancellation failed");
  expect(f.plugin.list("parent")[0].status).toBe("running");
  const first = f.plugin.stop("parent", task.agentId);
  const second = f.plugin.stop("parent", task.agentId);
  await Promise.all([first, second]);
  expect(actualStop).toHaveBeenCalledTimes(2);
  expect(f.plugin.list("parent")[0].status).toBe("aborted");
  await f.plugin.close();
});
