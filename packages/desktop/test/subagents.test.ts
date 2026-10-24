import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { AgentSession, SessionManager } from "zpi-coding-agent";
import { chunk, deferred, done, fakeModel, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup, codec, fixture, run } from "./helpers/context-fixture.ts";

const model = { provider: "p", modelId: "plain", reasoning: "none" };
const custom = {
  name: "code-reviewer",
  description: "Review code",
  systemPrompt: "Review only the requested code. CUSTOM ROLE",
  color: "purple" as const,
  injectAgentsMd: true,
  tools: ["read"],
};
const tools = (body: Record<string, unknown>) =>
  (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
const messages = (body: Record<string, unknown>) => body.messages as { role: string; content: string }[];
const call = (response: ServerResponse, params: unknown, name = "Agent", id = "agent-call") => {
  send(
    response,
    chunk({
      tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(params) } }],
    }),
  );
  done(response, "tool_calls");
};

test("persists Markdown profiles, preserves built-in colors, edits model overrides and isolates project scopes", async () => {
  const f = await fixture();
  const builtins = f.host.listSubagents(null).agents;
  expect(builtins.map((agent) => [agent.name, agent.color])).toEqual([
    ["general-purpose", "blue"],
    ["Explore", "cyan"],
  ]);
  const catalog = f.host.saveSubagent({
    config: { ...custom, modelSelection: model },
    scope: "user",
    sessionId: null,
  });
  const agent = catalog.agents.find((agent) => agent.name === custom.name);
  expect(await readFile(agent?.path as string, "utf8")).toContain("CUSTOM ROLE");
  f.host.subagents.profiles.enable(agent?.id as string, false);
  expect(f.host.listSubagents(null).agents.find((agent) => agent.name === custom.name)?.enabled).toBe(false);
  f.host.saveSubagent({
    id: builtins[0].id,
    config: { ...builtins[0], modelSelection: model },
    scope: "user",
    sessionId: null,
  });
  f.host.saveSubagent({
    config: { ...custom, name: "workspace-reviewer" },
    scope: "workspace",
    sessionId: f.session.id,
  });
  expect(f.host.listSubagents(null).agents.map((agent) => agent.name)).not.toContain("workspace-reviewer");
  await f.host.close();
  const restored = new SessionHost(f.dir, new SettingsStore(f.dir, codec), f.resources, f.workspace);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.listSubagents(null).agents[0].modelSelection).toEqual(model);
  expect(restored.listSubagents(null).agents.find((agent) => agent.name === custom.name)?.enabled).toBe(
    false,
  );
  expect(() =>
    restored.saveSubagent({ config: { ...custom, name: "../invalid" }, scope: "user", sessionId: null }),
  ).toThrow("配置无效");
  expect(() =>
    restored.saveSubagent({
      config: { ...custom, modelSelection: { ...model, modelId: "missing" } },
      scope: "user",
      sessionId: null,
    }),
  ).toThrow("可用模型");
  expect(() =>
    restored.saveSubagent({
      id: builtins[0].id,
      config: { ...builtins[0], systemPrompt: "changed" },
      scope: "user",
      sessionId: null,
    }),
  ).toThrow("仅支持修改模型");
  expect(() => restored.subagents.profiles.delete(builtins[0].id)).toThrow("不可删除");
  await mkdir(join(f.dir, "agents"), { recursive: true });
  await writeFile(join(f.dir, "agents", "bad.md"), "---\nname: bad\nname: duplicate\n---\nPrompt");
  expect(restored.listSubagents(null).diagnostics).toHaveLength(1);
});

test.each(["Explore", "general-purpose", "code-reviewer"])(
  "launches %s with isolated context and configured tools/model; restores full child history",
  async (name) => {
    const f = await fixture((body, response) => {
      if (!tools(body).includes("Agent")) {
        send(response, chunk({ content: "child findings" }));
        done(response);
        return;
      }
      if (!messages(body).some((message) => message.role === "tool"))
        call(response, {
          subagent_type: name,
          description: "Inspect source",
          prompt: "Find entry point CHILD REQUEST",
        });
      else {
        send(response, chunk({ content: "parent report" }));
        done(response);
      }
    });
    f.settings.setCapabilityEnabled("subagents", true);
    await mkdir(f.workspace, { recursive: true });
    await writeFile(join(f.workspace, "AGENTS.md"), "WORKSPACE POLICY");
    await mkdir(join(f.resources, ".zpi"), { recursive: true });
    await writeFile(join(f.resources, ".zpi", "AGENTS.md"), "USER POLICY");
    if (name === "code-reviewer")
      f.host.saveSubagent({ config: { ...custom, modelSelection: model }, scope: "user", sessionId: null });
    await run(f, "PARENT PRIVATE CONTEXT");
    const tasks = f.host.getSessionSnapshot(f.session.id).view.subagents ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "completed", result: "child findings", agentType: name });
    expect(f.host.listRecentSessions()).toHaveLength(1);
    const childRequest = f.server.requests.find((body) => !tools(body).includes("Agent"));
    expect(JSON.stringify(childRequest)).not.toContain("PARENT PRIVATE CONTEXT");
    expect(JSON.stringify(childRequest)).toContain("CHILD REQUEST");
    expect(tools(childRequest ?? {})).toEqual(
      name === "Explore"
        ? ["read", "bash", "TaskOutput", "TaskStop", "RespondToCoordinator"]
        : name === "code-reviewer"
          ? ["read", "RespondToCoordinator"]
          : [
              "read",
              "bash",
              "edit",
              "write",
              "TaskOutput",
              "TaskStop",
              "AskUserQuestion",
              "RespondToCoordinator",
            ],
    );
    expect(JSON.stringify(childRequest).includes("WORKSPACE POLICY")).toBe(name !== "Explore");
    expect(JSON.stringify(childRequest).includes("USER POLICY")).toBe(name !== "Explore");
    expect(childRequest?.model).toBe(name === "code-reviewer" ? "plain" : "vision");
    expect(f.host.getSessionSnapshot(tasks[0].childSessionId).view.runs[0].orderedBlocks).toContainEqual(
      expect.objectContaining({ type: "text", text: "child findings" }),
    );
    await f.host.close();
    const restored = new SessionHost(f.dir, new SettingsStore(f.dir, codec), f.resources, f.workspace);
    await restored.init();
    cleanup.push(() => restored.close());
    expect(restored.listRecentSessions()).toHaveLength(1);
    expect(restored.getSessionSnapshot(f.session.id).view.subagents?.[0]).toMatchObject({
      status: "completed",
      result: "child findings",
    });
    expect(restored.getSessionSnapshot(tasks[0].childSessionId).view.runs[0].orderedBlocks).toContainEqual(
      expect.objectContaining({ text: "child findings" }),
    );
  },
);

test("publishes child updates without rebuilding cached parent snapshots and restores evicted parents", async () => {
  const f = await fixture((body, response) => {
    if (tools(body).includes("Agent") && !messages(body).some((message) => message.role === "tool"))
      call(response, { description: "Inspect source", prompt: "Find entry point" });
    else {
      send(response, chunk({ content: "findings" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  await run(f, "Research");
  const task = f.host.subagents.list(f.session.id)[0];
  f.host.getSessionSnapshot(f.session.id);
  const snapshots = vi.spyOn(f.host, "getSessionSnapshot");
  try {
    f.host.subagents.update(task.agentId, { latestActivity: "cached update" });
    expect(snapshots).not.toHaveBeenCalled();
    const cached = f.host.getSessionSnapshot(f.session.id);
    expect(cached.view.subagents?.[0].latestActivity).toBe("cached update");
    for (let index = 0; index < 9; index++) f.host.getSessionSnapshot(f.host.createSession(null).id);
    snapshots.mockClear();
    f.host.subagents.update(task.agentId, { latestActivity: "restored update" });
    expect(snapshots).toHaveBeenCalledExactlyOnceWith(f.session.id);
    const restored = f.host.getSessionSnapshot(f.session.id);
    expect(restored.view.subagents?.[0].latestActivity).toBe("restored update");
    expect(restored.view.runs).toEqual(cached.view.runs);
    expect(restored.seq).toBe(cached.seq + 1);
  } finally {
    snapshots.mockRestore();
  }
});

test("plugin enablement defaults on and is frozen on first send, including restart", async () => {
  const f = await fixture();
  expect(f.host.listTools().map((tool) => tool.name)).toContain("Agent");
  await run(f, "first send");
  f.settings.setCapabilityEnabled("subagents", false);
  await run(f, "existing session");
  expect(tools(f.server.requests.at(-1) ?? {})).toContain("Agent");
  const next = f.host.createSession(null);
  await f.host.startRun({ sessionId: next.id, text: "new session" });
  await f.host.activeRuns.get(next.id)?.done;
  expect(tools(f.server.requests.at(-1) ?? {})).not.toContain("Agent");
  await f.host.close();
  f.settings.setCapabilityEnabled("subagents", true);
  const restored = new SessionHost(f.dir, new SettingsStore(f.dir, codec), f.resources, f.workspace);
  await restored.init();
  cleanup.push(() => restored.close());
  await restored.startRun({ sessionId: next.id, text: "restored" });
  await restored.activeRuns.get(next.id)?.done;
  expect(tools(f.server.requests.at(-1) ?? {})).not.toContain("Agent");
});

test("runs independent children concurrently and cancels them when the parent stops", async () => {
  const bothStarted = deferred();
  const children: ServerResponse[] = [];
  const f = await fixture((body, response) => {
    if (!tools(body).includes("Agent")) {
      children.push(response);
      if (children.length === 2) bothStarted.resolve();
      return;
    }
    send(
      response,
      chunk({
        tool_calls: [0, 1].map((index) => ({
          index,
          id: `child-${index}`,
          type: "function",
          function: {
            name: "Agent",
            arguments: JSON.stringify({ description: `Child ${index}`, prompt: `Read ${index}` }),
          },
        })),
      }),
    );
    done(response, "tool_calls");
  });
  f.settings.setCapabilityEnabled("subagents", true);
  const { runId } = await f.host.startRun({ sessionId: f.session.id, text: "Parallel work" });
  await bothStarted.promise;
  expect(f.host.subagents.list(f.session.id).filter((task) => task.status === "running")).toHaveLength(2);
  const childId = f.host.subagents.list(f.session.id)[0].childSessionId;
  const child = f.host.sessions.get(childId);
  const parent = f.host.sessions.get(f.session.id);
  assert(child && parent);
  const drain = deferred();
  const childAbort = child.abort.bind(child);
  const childSpy = vi.spyOn(child, "abort").mockImplementation(async () => {
    await childAbort();
    await drain.promise;
  });
  const parentSpy = vi.spyOn(parent, "abort");
  const stopping = f.host.abortRun({ sessionId: f.session.id, runId });
  try {
    // A slow child cleanup must not let the parent keep streaming or start another model step.
    await expect.poll(() => parentSpy.mock.calls.length).toBe(1);
  } finally {
    drain.resolve();
    await stopping;
    childSpy.mockRestore();
    parentSpy.mockRestore();
  }
  expect(f.host.subagents.list(f.session.id).map((task) => task.status)).toEqual(["aborted", "aborted"]);
  expect(f.host.activeRuns.size).toBe(0);
});

test("late background findings stay queued without waking the parent and survive restart until user input", async () => {
  const childStarted = deferred();
  let childResponse: ServerResponse | undefined;
  const f = await fixture((body, response) => {
    if (!tools(body).includes("Agent")) {
      childResponse = response;
      childStarted.resolve();
      return;
    }
    if (!messages(body).some((message) => message.role === "tool"))
      call(response, { description: "Background search", prompt: "Search", run_in_background: true });
    else {
      send(response, chunk({ content: "Agent is running" }));
      done(response);
    }
  });
  await run(f, "Start background research");
  await childStarted.promise;
  const requests = f.server.requests.length;
  expect(f.host.getSessionSnapshot(f.session.id).view.runs[0].status).toBe("completed");
  expect(f.host.subagents.list(f.session.id)[0].status).toBe("running");
  send(childResponse as ServerResponse, chunk({ content: "Background findings" }));
  done(childResponse as ServerResponse);
  await expect
    .poll(() => f.settings.state.getRuntime(f.session.id, "subagent_inbox")[0]?.data)
    .toHaveLength(1);
  expect(f.host.activeRuns.has(f.session.id)).toBe(false);
  expect(f.server.requests).toHaveLength(requests);
  expect(f.host.getSessionSnapshot(f.session.id).view.runs).toHaveLength(1);
  await f.host.close();
  const settings = new SettingsStore(f.dir, codec);
  const restored = new SessionHost(f.dir, settings, f.resources, f.workspace);
  cleanup.push(() => restored.close());
  await restored.init();
  expect(restored.activeRuns.size).toBe(0);
  expect(restored.subagents.list(f.session.id)[0]).toMatchObject({
    status: "completed",
    result: "Background findings",
  });
  const acceptedInbox = settings.state.getRuntime(f.session.id, "subagent_inbox")[0]?.data;
  await restored.startRun({ sessionId: f.session.id, text: "Use those findings" });
  await restored.activeRuns.get(f.session.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1))).toContain("Background findings");
  expect(settings.state.getRuntime(f.session.id, "subagent_inbox")[0]?.data).toEqual([]);
  expect(
    restored.sessions
      .get(f.session.id)
      ?.messages.filter(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("<task-notification>"),
      ),
  ).toHaveLength(1);
  // Simulate termination after transcript commit but before the inbox acknowledgement.
  settings.state.setRuntime(f.session.id, "subagent_inbox", "inbox", acceptedInbox, "queued");
  await restored.close();
  const recoveredSettings = new SettingsStore(f.dir, codec);
  const recovered = new SessionHost(f.dir, recoveredSettings, f.resources, f.workspace);
  cleanup.push(() => recovered.close());
  await recovered.init();
  expect(recoveredSettings.state.getRuntime(f.session.id, "subagent_inbox")[0]?.data).toEqual([]);
  await recovered.startRun({ sessionId: f.session.id, text: "Continue once more" });
  await recovered.activeRuns.get(f.session.id)?.done;
  expect(
    recovered.sessions
      .get(f.session.id)
      ?.messages.filter(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("<task-notification>"),
      ),
  ).toHaveLength(1);
});

test("a background result arriving during the final answer waits for the next user input", async () => {
  const answering = deferred();
  let childResponse: ServerResponse | undefined;
  let parentResponse: ServerResponse | undefined;
  const f = await fixture((body, response) => {
    if (!tools(body).includes("Agent")) {
      childResponse = response;
      return;
    }
    if (!messages(body).some((message) => message.role === "tool")) {
      call(response, { description: "Late SQL findings", prompt: "Research", run_in_background: true });
    } else if (JSON.stringify(messages(body)).includes("<task-notification>")) {
      send(response, chunk({ content: "Supplement only" }));
      done(response);
    } else {
      parentResponse = response;
      send(response, chunk({ content: "Complete main answer" }));
      answering.resolve();
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  await f.host.startRun({ sessionId: f.session.id, text: "Research" });
  await answering.promise;
  await expect.poll(() => !!childResponse).toBe(true);
  assert(childResponse);
  send(childResponse, chunk({ content: "Late findings" }));
  done(childResponse);
  await expect.poll(() => f.host.subagents.list(f.session.id)[0]?.status).toBe("completed");
  assert(parentResponse);
  done(parentResponse);
  await expect.poll(() => f.host.getSessionSnapshot(f.session.id).view.runs.at(-1)?.status).toBe("completed");
  expect(f.host.getSessionSnapshot(f.session.id).view.runs).toHaveLength(1);
  await f.host.activeRuns.get(f.session.id)?.done;
  const runs = f.host.getSessionSnapshot(f.session.id).view.runs;
  expect(runs[0].subagentNotification).toBeUndefined();
  expect(runs[0].orderedBlocks.flatMap((block) => (block.type === "text" ? [block.text] : []))).toEqual([
    "Complete main answer",
  ]);
  expect(runs[0].finalAnswerBlockIds).toHaveLength(1);
  expect(JSON.stringify(f.server.requests.at(-1))).not.toContain("Late findings");
  await run(f, "Continue with late findings");
  expect(JSON.stringify(f.server.requests.at(-1))).toContain("Late findings");
  expect(f.host.getSessionSnapshot(f.session.id).view.runs).toHaveLength(2);
});

test("SendMessage resumes a completed child with its own history and automatically returns follow-up results", async () => {
  const f = await fixture((body, response) => {
    const rows = messages(body);
    if (!tools(body).includes("Agent")) {
      send(
        response,
        chunk({
          content: rows.some((message) => message.content?.includes("Follow-up request"))
            ? "Follow-up findings"
            : "Initial findings",
        }),
      );
      done(response);
      return;
    }
    const lastTool = rows.filter((message) => message.role === "tool").at(-1) as
      | { name?: string; content: string }
      | undefined;
    if (!lastTool) call(response, { description: "Initial search", prompt: "Initial request" });
    else if (lastTool.content.includes("use SendMessage with to:")) {
      const to = /agentId: (agent_[a-z0-9-]+)/.exec(lastTool.content)?.[1];
      call(
        response,
        { to, summary: "Follow-up search", message: "Follow-up request" },
        "SendMessage",
        "follow-up",
      );
    } else {
      send(response, chunk({ content: "Coordinator report" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  await run(f, "Research and follow up");
  await expect.poll(() => f.host.subagents.list(f.session.id)[0].result).toBe("Follow-up findings");
  await run(f, "Collect follow-up findings");
  await expect.poll(() => JSON.stringify(f.server.requests).includes("<task-notification>")).toBe(true);
  await f.host.activeRuns.get(f.session.id)?.done;
  const task = f.host.subagents.list(f.session.id)[0];
  expect(f.host.getSessionSnapshot(task.childSessionId).view.runs).toHaveLength(2);
  const childRequests = f.server.requests.filter((body) => !tools(body).includes("Agent"));
  expect(JSON.stringify(childRequests[1])).toContain("Initial findings");
  expect(JSON.stringify(childRequests[1])).toContain("Follow-up request");
  expect(JSON.stringify(f.server.requests)).toContain("Follow-up findings");

  const other = f.host.createSession(null);
  await expect(f.host.subagents.stop(other.id, task.agentId)).rejects.toThrow("不属于当前会话");
});

test("child provider errors return failures without leaking into the parent runtime", async () => {
  const f = await fixture((body, response) => {
    if (!tools(body).includes("Agent")) {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "Child rejected" } }));
      return;
    }
    if (!messages(body).some((message) => message.role === "tool"))
      call(response, { description: "Child failure", prompt: "fail" });
    else {
      send(response, chunk({ content: "Handled child failure" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  await run(f, "Launch a child");
  expect(f.host.subagents.list(f.session.id)[0]).toMatchObject({ status: "error" });
  expect(f.host.getSessionSnapshot(f.session.id).view.runs[0]).toMatchObject({ status: "completed" });
  expect(f.host.getSessionSnapshot(f.session.id).view.runs[0].orderedBlocks).toContainEqual(
    expect.objectContaining({ type: "tool", name: "Agent", status: "error" }),
  );
});

test("built-in manual model overrides apply to child execution and leave the parent's model selection intact", async () => {
  const f = await fixture((body, response) => {
    if (!tools(body).includes("Agent")) {
      send(response, chunk({ content: "Manual model findings" }));
      done(response);
      return;
    }
    if (!messages(body).some((message) => message.role === "tool"))
      call(response, { description: "Manual model research", prompt: "Inspect" });
    else {
      send(response, chunk({ content: "Parent result" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  const builtin = f.host.listSubagents(null).agents[0];
  f.host.saveSubagent({
    id: builtin.id,
    config: { ...builtin, modelSelection: model },
    scope: "user",
    sessionId: null,
  });
  await run(f, "Run general-purpose with manual model");
  expect(f.server.requests.find((body) => !tools(body).includes("Agent"))?.model).toBe("plain");
  expect(f.host.getSessionSnapshot(f.session.id).controls.selection?.modelId).toBe("vision");
  expect(f.settings.get().lastSelection?.modelId).toBe("vision");
  expect(f.host.subagents.list(f.session.id)[0].modelLabel).toBe("Provider / plain");
});

test("child questions route to the parent interaction while the child reports its waiting state", async () => {
  const params = {
    questions: [
      {
        header: "方向",
        question: "选择检查范围？",
        multiSelect: false,
        options: [
          { label: "A", description: "核心" },
          { label: "B", description: "界面" },
        ],
      },
    ],
  };
  const f = await fixture((body, response) => {
    if (tools(body).includes("Agent")) {
      if (!messages(body).some((message) => message.role === "tool"))
        call(response, { description: "Clarify scope", prompt: "Ask then inspect" });
      else {
        send(response, chunk({ content: "Parent result" }));
        done(response);
      }
    } else if (!messages(body).some((message) => message.role === "tool"))
      call(response, params, "AskUserQuestion", "child-question");
    else {
      send(response, chunk({ content: "Child used answer" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  f.settings.setCapabilityEnabled("askUserQuestion", true);
  await f.host.startRun({ sessionId: f.session.id, text: "Delegate and ask" });
  await expect.poll(() => f.host.questions.get(f.session.id)?.id).toBe("child-question");
  expect(f.host.subagents.list(f.session.id)[0].waitingForInput).toBe(true);
  expect(f.host.getSessionSnapshot(f.session.id).view.question?.id).toBe("child-question");
  f.host.questions.respond(f.session.id, "child-question", { answers: { "选择检查范围？": "A" } });
  await f.host.activeRuns.get(f.session.id)?.done;
  expect(f.host.subagents.list(f.session.id)[0]).toMatchObject({
    status: "completed",
    waitingForInput: false,
    result: "Child used answer",
  });
});

test.each(["unknown-agent", "code-reviewer"])(
  "rejects unavailable profile %s without creating an orphan child",
  async (name) => {
    const f = await fixture((body, response) => {
      if (!messages(body).some((message) => message.role === "tool"))
        call(response, { description: "Unavailable agent", subagent_type: name, prompt: "Inspect" });
      else {
        send(response, chunk({ content: "Handled unavailable agent" }));
        done(response);
      }
    });
    f.settings.setCapabilityEnabled("subagents", true);
    if (name === "code-reviewer") {
      const catalog = f.host.saveSubagent({ config: custom, scope: "user", sessionId: null });
      const agent = catalog.agents.find((agent) => agent.name === name);
      f.host.subagents.profiles.enable(agent?.id as string, false);
    }
    await run(f, "Try the agent");
    expect(f.host.subagents.list(f.session.id)).toEqual([]);
    expect(f.host.listRecentSessions()).toHaveLength(1);
    expect(f.host.getSessionSnapshot(f.session.id).view.runs[0].orderedBlocks).toContainEqual(
      expect.objectContaining({
        name: "Agent",
        status: "error",
        output: expect.stringContaining("未知或已禁用"),
      }),
    );
  },
);

test("delivers SendMessage during a live child at the next model boundary without a new child turn", async () => {
  const ready = deferred();
  let childResponse: ServerResponse | undefined;
  let childRequests = 0;
  const f = await fixture((body, response) => {
    if (!tools(body).includes("Agent")) {
      if (++childRequests === 1) {
        childResponse = response;
        ready.resolve();
        return;
      }
      expect(JSON.stringify(body.messages)).toContain("Use revised scope");
      send(response, chunk({ content: "Revised findings" }));
      done(response);
      return;
    }
    if (!messages(body).some((message) => message.role === "tool"))
      call(response, { description: "Stable original title", prompt: "Inspect", run_in_background: true });
    else {
      send(response, chunk({ content: "Coordinator report" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  await run(f, "Start research");
  await ready.promise;
  const task = f.host.subagents.list(f.session.id)[0];
  const sendMessage = f.host.subagents.tools(f.session.id).find((tool) => tool.name === "SendMessage");
  assert(sendMessage);
  const response = await sendMessage.execute(
    "follow-up",
    {
      to: task.agentId,
      summary: "Revised scope",
      message: "Use revised scope",
    },
    undefined,
    undefined,
    {
      cwd: f.workspace,
      model: fakeModel(f.server.url),
      sessionManager: SessionManager.inMemory(),
      isIdle: () => false,
      getSystemPrompt: () => "",
    },
  );
  expect(JSON.stringify(response)).toContain("steered");
  expect(f.host.subagents.list(f.session.id)[0].description).toBe("Stable original title");
  assert(childResponse);
  send(childResponse, chunk({ content: "Initial partial findings" }));
  done(childResponse);
  await expect.poll(() => f.host.subagents.list(f.session.id)[0].result).toBe("Revised findings");
  expect(f.host.getSessionSnapshot(task.childSessionId).view.runs).toHaveLength(1);
  expect(childRequests).toBe(2);
  await run(f, "Collect revised findings");
  await expect.poll(() => JSON.stringify(f.server.requests).includes("<task-notification>")).toBe(true);
  await f.host.activeRuns.get(f.session.id)?.done;
});

test("RespondToCoordinator queues model-only progress and child continues to its final result", async () => {
  const f = await fixture((body, response) => {
    const rows = messages(body);
    if (!tools(body).includes("Agent")) {
      expect(tools(body)).toContain("RespondToCoordinator");
      expect(tools(body)).not.toContain("SendMessage");
      if (!rows.some((message) => message.role === "tool"))
        call(
          response,
          { summary: "Located source", message: "REPLY PRIVATE BODY" },
          "RespondToCoordinator",
          "reply",
        );
      else {
        send(response, chunk({ content: "Final child result" }));
        done(response);
      }
      return;
    }
    expect(tools(body)).not.toContain("RespondToCoordinator");
    if (!rows.some((message) => message.role === "tool"))
      call(response, { description: "Inspect", prompt: "Research and report progress" });
    else {
      expect(JSON.stringify(rows)).toContain("<subagent-message>");
      send(response, chunk({ content: "Coordinator used reply" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  await run(f, "Research");
  const task = f.host.subagents.list(f.session.id)[0];
  expect(task.result).toBe("Final child result");
  expect(f.host.getSessionSnapshot(f.session.id).view.runs).toHaveLength(1);
  expect(f.host.getSessionSnapshot(f.session.id).view.runs[0].userMessage).toBe("Research");
  expect(f.host.getSessionSnapshot(task.childSessionId).view.runs[0].orderedBlocks).toContainEqual(
    expect.objectContaining({ name: "RespondToCoordinator", status: "completed" }),
  );
  await expect(f.host.startRun({ sessionId: task.childSessionId, text: "Unexpected edit" })).rejects.toThrow(
    "只读",
  );
  expect(() => f.host.submitInput({ sessionId: task.childSessionId, text: "Unexpected edit" })).toThrow(
    "只读",
  );
});

test("startup guidance reaches the first child turn while input preparation is still pending", async () => {
  const f = await fixture((body, response) => {
    if (tools(body).includes("Agent") && !messages(body).some((row) => row.role === "tool"))
      call(response, { description: "Inspect", prompt: "Research" });
    else {
      send(response, chunk({ content: "findings" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  const prepare = AgentSession.prototype.prepareInput;
  let delivery: unknown;
  const spy = vi.spyOn(AgentSession.prototype, "prepareInput").mockImplementation(async function (
    this: AgentSession,
    ...args
  ) {
    const task = f.host.subagents.taskForChild(this.sessionId);
    if (task && delivery === undefined) {
      const tool = f.host.subagents.tools(f.session.id).find((item) => item.name === "SendMessage");
      assert(tool);
      delivery = await tool.execute(
        "guide",
        { to: task.agentId, summary: "New scope", message: "STARTUP GUIDANCE" },
        undefined,
        undefined,
        {
          cwd: f.workspace,
          model: fakeModel(f.server.url),
          sessionManager: SessionManager.inMemory(),
          isIdle: () => false,
          getSystemPrompt: () => "",
        },
      );
    }
    return prepare.apply(this, args);
  });
  try {
    await run(f, "Research");
    expect(JSON.stringify(delivery)).toContain("steered");
    const task = f.host.subagents.list(f.session.id)[0];
    expect(f.host.getSessionSnapshot(task.childSessionId).view.runs).toHaveLength(1);
    expect(f.server.requests.filter((body) => !tools(body).includes("Agent"))).toHaveLength(2);
    expect(JSON.stringify(f.server.requests)).toContain("STARTUP GUIDANCE");
  } finally {
    spy.mockRestore();
  }
});

test("a coordinator reply at the SDK settlement boundary remains queued for the next user turn", async () => {
  const f = await fixture((body, response) => {
    if (tools(body).includes("Agent") && !messages(body).some((row) => row.role === "tool"))
      call(response, { description: "Inspect", prompt: "Research" });
    else {
      send(response, chunk({ content: "findings" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  await run(f, "Research");
  const task = f.host.subagents.list(f.session.id)[0];
  const parent = f.host.sessions.get(f.session.id);
  assert(parent);
  let sent = false;
  let delivery: Promise<unknown> | undefined;
  const unsubscribe = parent.subscribe((event) => {
    if (event.type !== "agent_settled" || sent) return;
    sent = true;
    delivery = f.host.subagents.childTools(task.childSessionId)[0].execute(
      "reply",
      {
        summary: "Last moment reply",
        message: "BOUNDARY REPLY",
      },
      undefined,
      undefined,
      {
        cwd: f.workspace,
        model: fakeModel(f.server.url),
        sessionManager: SessionManager.inMemory(),
        isIdle: () => false,
        getSystemPrompt: () => "",
      },
    );
  });
  try {
    await run(f, "Follow up");
    await delivery;
    expect(f.host.activeRuns.has(f.session.id)).toBe(false);
    expect(f.host.getSessionSnapshot(f.session.id).view.runs).toHaveLength(2);
    expect(JSON.stringify(f.server.requests.at(-1))).not.toContain("BOUNDARY REPLY");
    await run(f, "Collect reply");
    expect(f.host.getSessionSnapshot(f.session.id).view.runs).toHaveLength(3);
    expect(JSON.stringify(f.server.requests.at(-1))).toContain("BOUNDARY REPLY");
  } finally {
    unsubscribe();
  }
});

test("guidance at child settlement keeps the foreground caller waiting for the follow-up result", async () => {
  const ready = deferred();
  let responseToFinish: ServerResponse | undefined;
  const f = await fixture((body, response) => {
    if (!tools(body).includes("Agent")) {
      if (JSON.stringify(body.messages).includes("LATE GUIDANCE")) {
        responseToFinish = response;
        ready.resolve();
      } else {
        send(response, chunk({ content: "First result" }));
        done(response);
      }
    } else if (!messages(body).some((row) => row.role === "tool"))
      call(response, { description: "Inspect", prompt: "Research" });
    else {
      send(response, chunk({ content: "Collected revised result" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  const prepare = AgentSession.prototype.prepareInput;
  let unsubscribe: (() => void) | undefined;
  let sent = false;
  const spy = vi.spyOn(AgentSession.prototype, "prepareInput").mockImplementation(function (
    this: AgentSession,
    ...args
  ) {
    const task = f.host.subagents.taskForChild(this.sessionId);
    if (task && !unsubscribe)
      unsubscribe = this.subscribe((event) => {
        if (event.type !== "agent_settled" || sent) return;
        sent = true;
        const tool = f.host.subagents.tools(f.session.id).find((item) => item.name === "SendMessage");
        assert(tool);
        void tool.execute(
          "guide",
          { to: task.agentId, summary: "Continue", message: "LATE GUIDANCE" },
          undefined,
          undefined,
          {
            cwd: f.workspace,
            model: fakeModel(f.server.url),
            sessionManager: SessionManager.inMemory(),
            isIdle: () => false,
            getSystemPrompt: () => "",
          },
        );
      });
    return prepare.apply(this, args);
  });
  try {
    const running = run(f, "Research");
    await ready.promise;
    expect(f.host.subagents.list(f.session.id)[0].status).toBe("running");
    expect(f.host.activeRuns.has(f.session.id)).toBe(true);
    assert(responseToFinish);
    send(responseToFinish, chunk({ content: "Revised result" }));
    done(responseToFinish);
    await running;
    expect(f.host.subagents.list(f.session.id)[0]).toMatchObject({
      status: "completed",
      result: "Revised result",
    });
    const toolResult = messages(f.server.requests.at(-1) ?? {}).findLast((row) => row.role === "tool");
    expect(toolResult?.content).toContain("Revised result");
    expect(toolResult?.content).not.toContain("First result");
  } finally {
    unsubscribe?.();
    spy.mockRestore();
  }
});

test("freezes agent definitions and inherited AGENTS.md for the complete parent turn", async () => {
  const started = deferred();
  let parentResponse: ServerResponse | undefined;
  const f = await fixture((body, response) => {
    if (!tools(body).includes("Agent")) {
      send(response, chunk({ content: "Child result" }));
      done(response);
      return;
    }
    if (!messages(body).some((message) => message.role === "tool")) {
      parentResponse = response;
      started.resolve();
    } else {
      send(response, chunk({ content: "Done" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  await mkdir(f.workspace, { recursive: true });
  await writeFile(join(f.workspace, "AGENTS.md"), "INITIAL WORKSPACE POLICY");
  const profile = f.host
    .saveSubagent({ config: custom, scope: "user", sessionId: null })
    .agents.find((agent) => agent.name === custom.name);
  assert(profile);
  await f.host.startRun({ sessionId: f.session.id, text: "Freeze definitions" });
  await started.promise;
  f.host.saveSubagent({
    id: profile.id,
    config: { ...custom, systemPrompt: "MODIFIED ROLE" },
    scope: "user",
    sessionId: null,
  });
  await writeFile(join(f.workspace, "AGENTS.md"), "MODIFIED WORKSPACE POLICY");
  assert(parentResponse);
  call(parentResponse, { subagent_type: custom.name, description: "Frozen task", prompt: "Inspect" });
  await f.host.activeRuns.get(f.session.id)?.done;
  const child = f.server.requests.find((body) => !tools(body).includes("Agent"));
  expect(JSON.stringify(child)).toContain("CUSTOM ROLE");
  expect(JSON.stringify(child)).toContain("INITIAL WORKSPACE POLICY");
  expect(JSON.stringify(child)).not.toContain("MODIFIED ROLE");
  expect(JSON.stringify(child)).not.toContain("MODIFIED WORKSPACE POLICY");
});

test("reads canonical Markdown selections, BOM/Markdown suffixes and preserves extra profile fields on edit", async () => {
  const f = await fixture();
  const path = join(f.dir, "agents", "reviewer.MARKDOWN");
  await mkdir(join(f.dir, "agents"), { recursive: true });
  await writeFile(
    path,
    "\uFEFF---\nname: reviewer\ndescription: Review\nmodel: p/plain\nthoughtLevel: none\ntools: Read, Bash\ndisallowedTools: Write\nskills: [lint]\nmaxTurns: 12\n---\nOriginal prompt\n",
  );
  const profile = f.host.listSubagents(null).agents.find((agent) => agent.name === "reviewer");
  assert(profile);
  expect(profile.modelSelection).toEqual(model);
  expect(profile.tools).toEqual(["read", "bash"]);
  expect(profile.disallowedTools).toEqual(["write"]);
  const updated = f.host
    .saveSubagent({
      id: profile.id,
      config: { ...profile, systemPrompt: "Updated prompt" },
      scope: "user",
      sessionId: null,
    })
    .agents.find((agent) => agent.name === "reviewer");
  assert(updated?.path);
  const content = await readFile(updated.path, "utf8");
  expect(content).toContain("model: p/plain");
  expect(content).toContain("thoughtLevel: none");
  expect(content).toContain("maxTurns: 12");
  expect(content).toContain("lint");
  expect(content).not.toContain("modelSelection:");
  const inherited = f.host
    .saveSubagent({
      id: updated.id,
      config: { ...updated, modelSelection: undefined },
      scope: "user",
      sessionId: null,
    })
    .agents.find((agent) => agent.name === "reviewer");
  assert(inherited?.path);
  expect(inherited.modelSelection).toBeUndefined();
  expect(await readFile(inherited.path, "utf8")).not.toContain("thoughtLevel:");
});

test("terminal resume uses the refreshed definition/model while retaining child identity, then rejects a disabled profile", async () => {
  let parentSteps = 0;
  let disabledAttempt = false;
  let agentId: string;
  const f = await fixture((body, response) => {
    if (!tools(body).includes("Agent")) {
      send(response, chunk({ content: parentSteps > 2 ? "Updated findings" : "Initial findings" }));
      done(response);
      return;
    }
    parentSteps++;
    if (parentSteps === 1)
      call(response, { description: "Stable task", subagent_type: custom.name, prompt: "Inspect" });
    else if (parentSteps === 3 || (disabledAttempt && parentSteps === 5))
      call(
        response,
        { to: agentId, summary: "Resume", message: "Continue the task" },
        "SendMessage",
        `resume-${parentSteps}`,
      );
    else {
      send(response, chunk({ content: "Coordinator report" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  const profile = f.host
    .saveSubagent({ config: custom, scope: "user", sessionId: null })
    .agents.find((agent) => agent.name === custom.name);
  assert(profile);
  await run(f, "Initial turn");
  const original = f.host.subagents.list(f.session.id)[0];
  agentId = original.agentId;
  f.host.saveSubagent({
    id: profile.id,
    config: { ...custom, modelSelection: model, systemPrompt: "UPDATED ROLE" },
    scope: "user",
    sessionId: null,
  });
  await run(f, "Resume child with refreshed definition");
  await expect.poll(() => f.host.subagents.list(f.session.id)[0].result).toBe("Updated findings");
  await f.host.activeRuns.get(f.session.id)?.done;
  const requests = f.server.requests.filter((body) => !tools(body).includes("Agent"));
  expect(requests[1].model).toBe("plain");
  expect(JSON.stringify(requests[1])).toContain("UPDATED ROLE");
  expect(JSON.stringify(requests[1])).toContain("Initial findings");
  expect(f.host.subagents.list(f.session.id)[0]).toMatchObject({
    agentId,
    childSessionId: original.childSessionId,
    description: "Stable task",
  });
  expect(f.host.getSessionSnapshot(original.childSessionId).view.runs).toHaveLength(2);
  f.host.subagents.profiles.enable(profile.id, false);
  // Completion may be consumed at the same boundary or in a model-only turn; start from a fresh ordinary turn.
  disabledAttempt = true;
  parentSteps = 4;
  await run(f, "Try resuming disabled child");
  expect(f.host.getSessionSnapshot(f.session.id).view.runs.at(-1)?.orderedBlocks).toContainEqual(
    expect.objectContaining({
      name: "SendMessage",
      status: "error",
      output: expect.stringContaining("未知或已禁用"),
    }),
  );
  expect(f.server.requests.filter((body) => !tools(body).includes("Agent"))).toHaveLength(2);
  expect(f.host.subagents.list(f.session.id)).toHaveLength(1);
});

test.each(["continue", "stop", "error"])(
  "handles a child result during parent generation: %s",
  async (action) => {
    const thinking = deferred();
    let childResponse: ServerResponse | undefined;
    let parentResponse: ServerResponse | undefined;
    const f = await fixture((body, response) => {
      if (!tools(body).includes("Agent")) {
        childResponse = response;
        return;
      }
      if (!messages(body).some((message) => message.role === "tool")) {
        call(response, { description: "Concurrent search", prompt: "Search", run_in_background: true });
      } else if (JSON.stringify(messages(body)).includes("<task-notification>")) {
        send(response, chunk({ content: "Combined findings" }));
        done(response);
      } else {
        parentResponse = response;
        send(response, chunk({ reasoning_content: "Working on independent work" }));
        thinking.resolve();
      }
    });
    await f.host.startRun({ sessionId: f.session.id, text: "Research in parallel" });
    const active = f.host.activeRuns.get(f.session.id);
    assert(active);
    await thinking.promise;
    await expect.poll(() => !!childResponse).toBe(true);
    assert(childResponse);
    assert(parentResponse);
    send(childResponse, chunk({ content: "EARLY CHILD FINDINGS" }));
    done(childResponse);
    await expect
      .poll(() => f.settings.state.getRuntime(f.session.id, "subagent_inbox")[0]?.data)
      .toHaveLength(1);
    if (action === "continue") {
      // Closing reasoning starts another request before the original HTTP response finishes.
      send(parentResponse, chunk({ content: "Stale planned answer" }));
      await active.done;
      expect(f.host.getSessionSnapshot(f.session.id).view.runs).toHaveLength(1);
      expect(JSON.stringify(f.server.requests.at(-1))).toContain("EARLY CHILD FINDINGS");
      expect(JSON.stringify(f.host.sessions.get(f.session.id)?.messages)).not.toContain(
        "Stale planned answer",
      );
      expect(f.settings.state.getRuntime(f.session.id, "subagent_inbox")[0]?.data).toEqual([]);
    } else {
      if (action === "stop") await f.host.abortRun({ sessionId: f.session.id, runId: active.runId });
      else {
        send(parentResponse, { error: { message: "Permanent provider failure" } });
        parentResponse.end();
        await active.done;
      }
      expect(f.host.getSessionSnapshot(f.session.id).view.runs).toHaveLength(1);
      expect(f.host.activeRuns.has(f.session.id)).toBe(false);
      expect(f.settings.state.getRuntime(f.session.id, "subagent_inbox")[0]?.data).toHaveLength(1);
      expect(f.host.subagents.list(f.session.id)[0].result).toBe("EARLY CHILD FINDINGS");
      await run(f, "Continue after interruption");
      expect(JSON.stringify(f.server.requests.at(-1))).toContain("EARLY CHILD FINDINGS");
    }
  },
);
