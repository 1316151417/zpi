import { expect, test } from "vitest";
import { SessionManager } from "zpi-coding-agent";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup, codec, fixture, run } from "./helpers/context-fixture.ts";

test("desktop Bash and shared controls work with subagents disabled; services outlive turns and persist terminal history", async () => {
  const f = await fixture((body, response) => {
    const messages = body.messages as { role: string; content: string }[];
    if (!messages.some((message) => message.role === "tool")) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "service",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({
                  command: "echo ready; sleep 30",
                  description: "Dev server",
                  run_in_background: true,
                }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "Server started" }));
      done(response);
    }
  });
  await run(f, "Start a server");
  const task = f.host.getSessionSnapshot(f.session.id).view.backgroundTasks?.[0];
  if (!task) throw new Error("Missing background task");
  expect(task).toMatchObject({ status: "running", description: "Dev server" });
  const names = (f.server.requests[0].tools as { function: { name: string } }[]).map(
    (tool) => tool.function.name,
  );
  expect(names).toEqual(["read", "bash", "edit", "write", "TaskOutput", "TaskStop"]);
  const controls = f.host.taskTools(f.session.id, false);
  const session = f.host.sessions.get(f.session.id);
  if (!session) throw new Error("Missing agent session");
  const context = {
    cwd: f.workspace,
    model: session.model,
    sessionManager: SessionManager.inMemory(),
    isIdle: () => true,
    getSystemPrompt: () => "",
  };
  const outputTool = controls.find((tool) => tool.name === "TaskOutput");
  const stopTool = controls.find((tool) => tool.name === "TaskStop");
  if (!outputTool || !stopTool) throw new Error("Missing task controls");
  const output = await outputTool.execute(
    "read",
    { task_id: task.taskId, block: false },
    undefined,
    undefined,
    context,
  );
  expect(output.details).toMatchObject({ retrieval_status: "not_ready", task: { task_type: "local_bash" } });
  await stopTool.execute("stop", { task_id: task.taskId }, undefined, undefined, context);
  expect(f.host.getSessionSnapshot(f.session.id).view.backgroundTasks?.[0].status).toBe("cancelled");
  await f.host.close();
  const restored = new SessionHost(f.dir, new SettingsStore(f.dir, codec), f.resources, f.workspace);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.getSessionSnapshot(f.session.id).view.backgroundTasks?.[0]).toMatchObject({
    taskId: task.taskId,
    status: "cancelled",
  });
  expect((await restored.backgroundTasks.read(f.session.id, task.taskId)).output).toContain("ready");
});

test("completion wakes an idle owner with a model-only task notification", async () => {
  const f = await fixture((body, response) => {
    const messages = body.messages as { role: string; content: string }[];
    if (!messages.some((message) => message.role === "tool")) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "job",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: "sleep 0.2; echo built", run_in_background: true }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(
        response,
        chunk({
          content: messages.some((message) => message.content?.includes("<task-notification>"))
            ? "Build finished"
            : "Working",
        }),
      );
      done(response);
    }
  });
  await run(f, "Build");
  await expect
    .poll(
      () =>
        f.host
          .getSessionSnapshot(f.session.id)
          .view.runs.filter((run) => run.subagentNotification && run.status === "completed").length,
    )
    .toBe(1);
  const snapshot = f.host.getSessionSnapshot(f.session.id).view;
  expect(snapshot.backgroundTasks?.[0].status).toBe("completed");
  expect(snapshot.runs.at(-1)).toMatchObject({ subagentNotification: { agentType: "bash" } });
  expect(JSON.stringify(f.server.requests.at(-1))).toContain("task-notification");
});

test("archive stops a live service before hiding its session", async () => {
  const f = await fixture((body, response) => {
    const messages = body.messages as { role: string }[];
    if (!messages.some((message) => message.role === "tool")) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "job",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: "sleep 30", run_in_background: true }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "Started" }));
      done(response);
    }
  });
  await run(f, "Start");
  await f.host.archiveSession(f.session.id);
  expect(f.host.backgroundTasks.list(f.session.id)[0].status).toBe("cancelled");
});

test("child services appear in the parent panel and archive cleans them even after the agent finishes", async () => {
  const f = await fixture((body, response) => {
    const names = (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    const child = !names.includes("Agent");
    const messages = body.messages as { role: string }[];
    if (!messages.some((message) => message.role === "tool")) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: child ? "service" : "agent",
              type: "function",
              function: {
                name: child ? "bash" : "Agent",
                arguments: JSON.stringify(
                  child
                    ? { command: "echo child-ready; sleep 30", run_in_background: true }
                    : { description: "Launch service", prompt: "Start child service" },
                ),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "Started" }));
      done(response);
    }
  });
  f.settings.setCapabilityEnabled("subagents", true);
  await run(f, "Delegate server startup");
  const view = f.host.getSessionSnapshot(f.session.id).view;
  expect(view.subagents?.[0].status).toBe("completed");
  const task = view.backgroundTasks?.[0];
  if (!task) throw new Error("Missing child service");
  expect(task.sessionId).toBe(view.subagents?.[0].childSessionId);
  expect(task.status).toBe("running");
  await expect(f.host.backgroundTasks.read(f.session.id, task.taskId)).rejects.toThrow("不存在");
  expect((await f.host.backgroundTasks.read(task.sessionId, task.taskId)).output).toContain("child-ready");
  await f.host.archiveSession(f.session.id);
  expect(f.host.backgroundTasks.list(task.sessionId)[0].status).toBe("cancelled");
});
