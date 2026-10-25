import { readFile, writeFile } from "node:fs/promises";
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

function fixture(toolNames?: string[]) {
  const profiles = new SubagentProfiles("/unused", { getSetting: () => undefined, setSetting: () => {} });
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
      getToolNames: () => toolNames ?? ["read", "bash"],
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
    `<tool_use_error>No task found with ID: ${task.agentId}</tool_use_error>`,
  );
  await expect(f.invoke("TaskOutput", { task_id: task.agentId, timeout: 600001 })).rejects.toThrow(
    "InputValidationError",
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
  expect(
    (await f.invoke("SendMessage", { to: task.agentId, summary: "Continue", message: "Next" })).details,
  ).toMatchObject({ status: "failed", message: `SendMessage was aborted for ${task.agentId}.` });
  await Promise.all([stopping, again]);
  expect(f.port.stop).toHaveBeenCalledTimes(1);
  expect(f.plugin.list("parent")[0]).toMatchObject({ status: "aborted", waitingForInput: false });
  expect((await f.invoke("TaskOutput", { task_id: task.agentId })).details).toMatchObject({
    retrieval_status: "success",
    task: { status: "killed" },
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

test("queued follow-ups stay running and stoppable without exposing an earlier turn's result", async () => {
  const f = fixture();
  const delivery = deferred();
  vi.mocked(f.port.notify).mockImplementationOnce(() => delivery.promise);
  vi.mocked(f.port.steer).mockReturnValue(false);
  const task = await f.launch();
  try {
    f.turns.get(task.childSessionId)?.resolve();
    await vi.waitFor(() => expect(f.port.notify).toHaveBeenCalledTimes(1));
    for (const message of ["First follow-up", "Second follow-up"])
      expect(
        (await f.invoke("SendMessage", { to: task.agentId, summary: message, message })).content,
      ).toEqual([
        {
          type: "text",
          text: expect.stringMatching(/resumed it in the background|Message queued for delivery/),
        },
      ]);
    delivery.resolve();
    await vi.waitFor(() => expect(f.port.run).toHaveBeenCalledTimes(2));
    const received = vi.fn();
    const waiting = f.invoke("TaskOutput", { task_id: task.agentId }).then((output) => {
      received();
      return output;
    });
    f.turns.get(task.childSessionId)?.resolve();
    await vi.waitFor(() => expect(f.port.run).toHaveBeenCalledTimes(3));
    expect(f.plugin.list("parent")[0]).toMatchObject({ status: "running", result: undefined });
    expect(received).not.toHaveBeenCalled();
    expect((await f.invoke("TaskOutput", { task_id: task.agentId, block: false })).details).toMatchObject({
      retrieval_status: "not_ready",
      task: { status: "running", output: "findings" },
    });
    await f.invoke("TaskStop", { task_id: task.agentId });
    expect(f.port.stop).toHaveBeenCalledWith(task.childSessionId);
    expect((await waiting).details).toMatchObject({ task: { status: "killed" } });
  } finally {
    delivery.resolve();
    await f.plugin.close();
  }
});

test("failed and restored interrupted tasks expose status and error without transcript replay", async () => {
  const f = fixture();
  vi.mocked(f.port.run).mockRejectedValueOnce(new Error("provider unavailable"));
  const task = await f.launch();
  const output = await f.invoke("TaskOutput", { task_id: task.agentId });
  expect(output.details).toMatchObject({
    retrieval_status: "success",
    task: { status: "failed", error: "provider unavailable" },
  });
  f.plugin.restore({ ...task, agentId: "restored", childSessionId: "restored-child", status: "running" });
  expect((await f.invoke("TaskOutput", { task_id: "restored" })).details).toMatchObject({
    task: { status: "killed" },
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

test("TaskStop accepts the ZCode shell_id alias and preserves missing, stale and lookup failure guidance", async () => {
  const f = fixture();
  const task = await f.launch();
  await expect(f.invoke("TaskStop", {})).rejects.toThrow("Missing required parameter: task_id");
  await expect(f.invoke("TaskStop", { task_id: "missing" })).rejects.toThrow(
    'Invalid task ID "missing". This lookup failure does not mean the task has completed or stopped; use the full task_id returned when the task started to stop it.',
  );
  const stopped = await f.invoke("TaskStop", { shell_id: task.agentId });
  expect(stopped.content).toEqual([
    {
      type: "text",
      text: JSON.stringify({
        message: `Successfully stopped task: ${task.agentId} (${task.description})`,
        task_id: task.agentId,
        task_type: "local_agent",
        command: task.description,
      }),
    },
  ]);
  await expect(f.invoke("TaskStop", { task_id: task.agentId })).rejects.toThrow(
    `Task ${task.agentId} is not running (status: killed)`,
  );
});

test("failed coordinator delivery retains the complete ZCode continuation instruction", async () => {
  const f = fixture();
  const task = await f.launch();
  vi.mocked(f.port.notify).mockRejectedValueOnce(new Error("Parent unavailable"));
  const reply = await f.plugin
    .childTools(task.childSessionId)[0]
    .execute("reply", { summary: "Progress", message: "Findings" }, undefined, undefined, {
      cwd: "/workspace",
      model: fakeModel(""),
      sessionManager: SessionManager.inMemory(),
      isIdle: () => false,
      getSystemPrompt: () => "",
    });
  expect(reply.isError).toBeUndefined();
  expect(reply.content).toEqual([
    {
      type: "text",
      text: expect.stringMatching(
        /^Response response_[\w-]+ failed to queue for the coordinator\. Continue the current task unless the coordinator explicitly changed or ended it\. Failure: Parent unavailable\.$/,
      ),
    },
  ]);
  await f.plugin.close();
});

test.each([true, false])(
  "background launch returns the complete ZCode branch (read tools: %s)",
  async (readable) => {
    const f = fixture(readable ? ["read"] : []);
    const launched = await f.invoke("Agent", {
      description: "Inspect",
      prompt: "Search",
      run_in_background: true,
    });
    const task = f.plugin.list("parent")[0];
    expect(launched.details).toEqual({
      status: "async_launched",
      isAsync: true,
      agentId: task.agentId,
      agentType: "general-purpose",
      description: "Inspect",
      prompt: "Search",
      childSessionId: task.childSessionId,
      backgroundTaskId: task.agentId,
      outputFile: task.outputFile,
      canReadOutputFile: readable,
    });
    const common = `Async agent launched successfully.\nagentId: ${task.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${task.agentId}' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.`;
    expect(launched.content).toEqual([
      {
        type: "text",
        text:
          common +
          (readable
            ? `\nDo not duplicate this agent's work - avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.\noutput_file: ${task.outputFile}\nDo NOT Read or tail this file via the shell tool. If the user asks for progress, say the agent is still running; you'll get a completion notification.`
            : "\nBriefly tell the user what you launched and end your response. Do not generate any other text - agent results will arrive in a subsequent message."),
      },
    ]);
    expect(JSON.parse(await readFile(task.metadataFile as string, "utf8"))).toMatchObject({
      status: "running",
      agentId: task.agentId,
      prompt: "Search",
    });
    f.turns.get(task.childSessionId)?.resolve();
    await vi.waitFor(() => expect(f.port.notify).toHaveBeenCalledTimes(1));
    expect(await readFile(task.outputFile as string, "utf8")).toBe("findings");
    expect(await readFile(task.taskOutputFile as string, "utf8")).toBe("findings");
    await f.plugin.close();
  },
);

test("SendMessage uses the runner's active, queued, resumed and failure results", async () => {
  const f = fixture();
  const task = await f.launch();
  const active = await f.invoke("SendMessage", {
    to: task.agentId,
    summary: "Scope",
    message: "New request",
  });
  expect(active.content).toEqual([
    {
      type: "text",
      text: expect.stringMatching(
        new RegExp(`^Message msg_[\\w-]+ was sent to its active turn for local agent ${task.agentId}\\.$`),
      ),
    },
  ]);
  expect(f.port.steer).toHaveBeenLastCalledWith(
    task.childSessionId,
    "<system-reminder>\nThe coordinator sent a message while you were working:\nScope\n\nNew request\n\nAddress this before completing your current task.\n</system-reminder>",
  );
  expect(
    (await f.invoke("SendMessage", { to: "missing", summary: "Scope", message: "Request" })).details,
  ).toMatchObject({
    status: "failed",
    agentId: "missing",
    error: "No active local_agent task found for target missing.",
    message: "No active local_agent task found for target missing.",
  });
  f.turns.get(task.childSessionId)?.resolve();
  await vi.waitFor(() => expect(f.port.notify).toHaveBeenCalledTimes(1));
  const resumed = await f.invoke("SendMessage", {
    to: task.agentId,
    summary: "Follow up",
    message: "Only this prompt",
  });
  expect(resumed.content).toEqual([
    {
      type: "text",
      text: `Agent "${task.agentId}" was stopped (completed); resumed it in the background with your message. You'll be notified when it finishes. Output: ${task.outputFile}`,
    },
  ]);
  await vi.waitFor(() => expect(f.port.run).toHaveBeenCalledTimes(2));
  expect(f.port.run).toHaveBeenLastCalledWith(
    task.childSessionId,
    "Only this prompt",
    expect.any(Object),
    expect.any(Object),
  );
  expect(f.plugin.list("parent")[0]).toMatchObject({ description: "Follow up", parentToolCallId: "call" });
  vi.mocked(f.port.steer).mockReturnValue(false);
  const queued = await f.invoke("SendMessage", {
    to: task.agentId,
    summary: "More",
    message: "Queued request",
  });
  expect(queued.content).toEqual([
    { type: "text", text: `Message queued for delivery to ${task.agentId} at its next tool round.` },
  ]);
  await f.plugin.close();
});

test("TaskOutput reads the real clean output file, preserves whitespace and returns the ZCode status", async () => {
  const f = fixture();
  const task = await f.launch();
  await writeFile(task.outputFile as string, "disk snapshot\n\n");
  const current = await f.invoke("TaskOutput", { task_id: task.agentId, block: false });
  expect(current.content).toEqual([
    {
      type: "text",
      text: `<retrieval_status>not_ready</retrieval_status>\n\n<task_id>${task.agentId}</task_id>\n\n<task_type>local_agent</task_type>\n\n<status>running</status>\n\n<output>\ndisk snapshot\n</output>`,
    },
  ]);
  await f.invoke("TaskStop", { task_id: task.agentId });
  const stopped = await f.invoke("TaskOutput", { task_id: task.agentId });
  expect(stopped.details).toMatchObject({
    retrieval_status: "success",
    task: {
      status: "killed",
      output: "Background agent task stopped.\n",
      error: "Background agent task stopped.",
    },
  });
});

test.each(["", "  \n", "x".repeat(130000)])(
  "foreground Agent handles blank and artifact results (%#.0)",
  async (answer) => {
    const f = fixture();
    vi.mocked(f.port.run).mockImplementation(async (id) => {
      const task = f.plugin.taskForChild(id) as SubagentTask;
      f.plugin.update(task.agentId, {
        status: "completed",
        result: answer,
        endedAt: Date.now(),
        totalToolUseCount: 2,
        totalTokens: 0,
        tokensReported: true,
      });
    });
    const reply = await f.invoke("Agent", { description: "Inspect", prompt: "Search" });
    const text = reply.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    const task = f.plugin.list("parent")[0];
    if (answer.length > 120000) {
      expect(text).toContain("<persisted-output>\nOutput too large (130 KB). Full output saved to: ");
      const path = /Full output saved to: (.*)/.exec(text)?.[1];
      expect(await readFile(path as string, "utf8")).toBe(
        `${answer}\nagentId: ${task.agentId} (use SendMessage with to: '${task.agentId}' to continue this agent)\n<usage>subagent_tokens: 0\ntool_uses: 2\nduration_ms: ${(task.endedAt as number) - task.startedAt}</usage>`,
      );
    } else
      expect(text).toBe(
        `(Subagent completed but returned no output.)\nagentId: ${task.agentId} (use SendMessage with to: '${task.agentId}' to continue this agent)\n<usage>subagent_tokens: 0\ntool_uses: 2\nduration_ms: ${(task.endedAt as number) - task.startedAt}</usage>`,
      );
    await f.plugin.close();
  },
);

test("TaskOutput persists its full formatted result at the character budget", async () => {
  vi.stubEnv("TASK_MAX_OUTPUT_LENGTH", "160000");
  const f = fixture();
  const task = await f.launch();
  const answer = "结果".repeat(60000);
  await writeFile(task.outputFile as string, answer);
  const reply = await f.invoke("TaskOutput", { task_id: task.agentId, block: false });
  const text = reply.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  expect(text).toContain("<persisted-output>\nOutput too large (");
  expect(text).toContain("Preview (first 2KB):");
  const path = /Full output saved to: (.*)/.exec(text)?.[1];
  const complete = await readFile(path as string, "utf8");
  expect(complete).toContain(`<output>\n${answer}\n</output>`);
  expect(reply.details).toMatchObject({ task: { output: answer } });
  await f.plugin.close();
});

test("long coordinator failures retain the continuation and ZCode byte-budget suffix", async () => {
  const f = fixture();
  const task = await f.launch();
  const error = "失败详情".repeat(2000);
  vi.mocked(f.port.notify).mockRejectedValueOnce(new Error(error));
  const reply = await f.plugin
    .childTools(task.childSessionId)[0]
    .execute("reply", { summary: "Progress", message: "Findings" }, undefined, undefined, {
      cwd: "/workspace",
      model: fakeModel(""),
      sessionManager: SessionManager.inMemory(),
      isIdle: () => false,
      getSystemPrompt: () => "",
    });
  const text = reply.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
  expect(text).toContain("Continue the current task unless the coordinator explicitly changed or ended it.");
  expect(text).toMatch(
    /\n\n\[Tool output truncated by resultBudget: originalBytes=\d+, maxModelBytes=4096, strategy=truncate\]$/,
  );
  expect(reply.details).toMatchObject({ status: "failed", error });
  expect(reply.isError).toBeUndefined();
  await f.plugin.close();
});

test("the completed task card is published after output files and inbox acceptance", async () => {
  const f = fixture();
  const accepted = deferred();
  vi.mocked(f.port.notify).mockImplementation(() => accepted.promise);
  const task = await f.launch();
  vi.mocked(f.port.publish).mockClear();
  f.turns.get(task.childSessionId)?.resolve();
  await vi.waitFor(() => expect(f.port.notify).toHaveBeenCalledTimes(1));
  expect(await readFile(task.outputFile as string, "utf8")).toBe("findings");
  expect(f.port.publish).not.toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  accepted.resolve();
  await vi.waitFor(() =>
    expect(f.port.publish).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" })),
  );
  await f.plugin.close();
});

test("stopping a foreground child returns a failure instead of an empty successful result", async () => {
  const f = fixture();
  const launched = f.invoke("Agent", { description: "Inspect", prompt: "Search" });
  const failed = expect(launched).rejects.toThrow("Background agent task stopped.");
  await vi.waitFor(() => expect(f.plugin.list("parent")).toHaveLength(1));
  const task = f.plugin.list("parent")[0];
  await f.plugin.stop("parent", task.agentId);
  await failed;
  await f.plugin.close();
});
