// Agent launch and SendMessage contracts follow ZCode (Apache-2.0).
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolDefinition } from "zpi-coding-agent";
import type { SubagentTask } from "zpi-ui";
import type { CombinedSelection } from "../../../shared/bridge.ts";
import type { SubagentProfile } from "../../../shared/subagents.ts";
import type { SubagentProfiles } from "./profiles.ts";

interface SubagentPort {
  cwd(parentId: string): string;
  selection(parentId: string): CombinedSelection;
  create(
    parentId: string,
    profile: SubagentProfile,
    selection: CombinedSelection,
    description: string,
  ): Promise<string>;
  run(
    childId: string,
    prompt: string,
    profile?: SubagentProfile,
    selection?: CombinedSelection,
  ): Promise<void>;
  steer(childId: string, prompt: string): boolean;
  stop(childId: string): Promise<void>;
  publish(task: SubagentTask): void;
  notify(task: SubagentTask, message?: { summary: string; message: string }): Promise<void>;
}
const launchParameters = Type.Object(
  {
    description: Type.String({
      minLength: 1,
      maxLength: 200,
      description: "A short (3-5 word) description of the task",
    }),
    prompt: Type.String({
      minLength: 1,
      maxLength: 100000,
      description: "The task for the agent to perform",
    }),
    subagent_type: Type.Optional(
      Type.String({ description: "The type of specialized agent to use for this task" }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({ description: "Run in the background; you will be notified when it completes" }),
    ),
  },
  { additionalProperties: false },
);
const messageParameters = Type.Object(
  {
    to: Type.String({ minLength: 1, maxLength: 200 }),
    summary: Type.String({ minLength: 1, maxLength: 200 }),
    message: Type.String({ minLength: 1, maxLength: 20000 }),
  },
  { additionalProperties: false },
);
const responseParameters = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: 200 }),
    message: Type.String({ minLength: 1, maxLength: 20000 }),
  },
  { additionalProperties: false },
);
const stopParameters = Type.Object(
  { task_id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

export class SubagentPlugin {
  readonly tasks = new Map<string, SubagentTask>();
  private childAgents = new Map<string, string>();
  private jobs = new Map<string, Promise<void>>();
  private closing = false;
  private cancellations = new Map<string, number>();
  private definitions = new Map<string, SubagentProfile[]>();
  readonly profiles: SubagentProfiles;
  private port: SubagentPort;
  constructor(profiles: SubagentProfiles, port: SubagentPort) {
    this.profiles = profiles;
    this.port = port;
  }
  prepare(parentId: string) {
    const agents = this.profiles.list(this.port.cwd(parentId)).agents.filter((agent) => agent.enabled);
    this.definitions.set(
      parentId,
      structuredClone([...new Map(agents.map((agent) => [agent.name, agent])).values()]),
    );
  }
  listing(parentId: string) {
    return (this.definitions.get(parentId) ?? [])
      .map(
        (agent) =>
          `- ${agent.name}: ${agent.description}${agent.tools ? ` (Tools: ${agent.tools.filter((tool) => !agent.disallowedTools?.includes(tool)).join(", ")})` : ""}`,
      )
      .join("\n");
  }
  private profile(parentId: string, name: string) {
    const profile = this.definitions.get(parentId)?.findLast((agent) => agent.name === name);
    if (!profile) throw new Error(`configuration: 未知或已禁用的子智能体 ${name}`);
    return structuredClone(profile);
  }
  childTools(childId: string): ToolDefinition[] {
    return [
      {
        name: "RespondToCoordinator",
        label: "回复",
        parameters: responseParameters,
        description:
          "Respond to the coordinator that owns this subagent. When you receive a message from the coordinator, use this tool for a concise response or progress update. Continue the current task unless the coordinator changed or ended it. This does not replace the final task result.",
        metadata: { concurrentSafe: true, sideEffectScope: "session", destructive: false },
        execute: async (_id, params, signal) => {
          if (!Value.Check(responseParameters, params))
            throw new Error("invalid_input: RespondToCoordinator 参数无效");
          signal?.throwIfAborted();
          const task = this.taskForChild(childId);
          if (!task || this.closing)
            throw new Error("configuration: Coordinator response port is not configured");
          await this.port.notify(task, params);
          return result(
            JSON.stringify({
              status: "success",
              responseId: randomUUID(),
              message:
                "Response queued for the coordinator. Continue the current task unless directed otherwise.",
            }),
          );
        },
      },
    ];
  }
  list(parentId: string) {
    return structuredClone([...this.tasks.values()].filter((task) => task.parentSessionId === parentId));
  }
  restore(task: SubagentTask) {
    this.childAgents.set(task.childSessionId, task.agentId);
    this.tasks.set(task.agentId, {
      ...task,
      ...(task.status === "running"
        ? { status: "interrupted" as const, endedAt: Date.now(), waitingForInput: false }
        : {}),
    });
  }
  taskForChild(childSessionId: string) {
    const id = this.childAgents.get(childSessionId);
    return id ? this.tasks.get(id) : undefined;
  }
  forgetSession(id: string) {
    this.definitions.delete(id);
    for (const task of this.tasks.values())
      if (task.childSessionId === id || task.parentSessionId === id) {
        this.tasks.delete(task.agentId);
        this.childAgents.delete(task.childSessionId);
      }
  }
  update(agentId: string, fields: Partial<SubagentTask>) {
    const previous = this.tasks.get(agentId);
    if (!previous) return;
    const next = { ...previous, ...fields };
    this.tasks.set(agentId, next);
    this.port.publish(next);
  }
  private owned(parentId: string, agentId: string) {
    const task = this.tasks.get(agentId);
    if (!task || task.parentSessionId !== parentId) throw new Error("not_found: 子智能体不属于当前会话");
    return task;
  }
  async stop(parentId: string, agentId: string) {
    const task = this.owned(parentId, agentId);
    if (task.status !== "running" && !this.jobs.has(agentId)) throw new Error("busy: 子智能体已结束");
    this.cancellations.set(agentId, (this.cancellations.get(agentId) ?? 0) + 1);
    // Mark before cancelling so background completion cannot wake the stopped parent.
    this.update(agentId, { status: "aborted", endedAt: Date.now() });
    await this.port.stop(task.childSessionId);
    await this.jobs.get(agentId);
  }
  async stopAll(parentId: string) {
    await Promise.all(
      this.list(parentId)
        .filter((task) => task.status === "running")
        .map((task) => this.stop(parentId, task.agentId)),
    );
  }
  async close() {
    this.closing = true;
    await Promise.all(
      [...this.tasks.values()]
        .filter((task) => task.status === "running")
        .map((task) => this.stop(task.parentSessionId, task.agentId)),
    );
  }
  private begin(
    task: SubagentTask,
    prompt: string,
    resume?: { profile: SubagentProfile; selection: CombinedSelection },
  ) {
    const previous = this.jobs.get(task.agentId);
    const generation = this.cancellations.get(task.agentId) ?? 0;
    let done!: Promise<void>;
    done = (async () => {
      await previous?.catch(() => {});
      if (
        this.closing ||
        generation !== (this.cancellations.get(task.agentId) ?? 0) ||
        (!resume && this.tasks.get(task.agentId)?.status === "aborted")
      )
        return;
      if (resume)
        this.update(task.agentId, {
          background: true,
          status: "running",
          startedAt: Date.now(),
          endedAt: undefined,
          error: undefined,
          latestActivity: undefined,
          result: undefined,
        });
      try {
        await this.port.run(task.childSessionId, prompt, resume?.profile, resume?.selection);
      } catch (error) {
        if (this.tasks.get(task.agentId)?.status !== "aborted")
          this.update(task.agentId, { status: "error", error: String(error), endedAt: Date.now() });
      }
      const latest = this.tasks.get(task.agentId);
      // Only the last queued turn notifies the parent, with the complete follow-up result.
      if (
        this.jobs.get(task.agentId) === done &&
        latest?.background &&
        latest.status !== "aborted" &&
        !this.closing
      )
        await this.port.notify(latest);
    })().finally(() => {
      if (this.jobs.get(task.agentId) === done) this.jobs.delete(task.agentId);
    });
    this.jobs.set(task.agentId, done);
    void done.catch(() => {});
    return done;
  }
  tools(parentId: string): ToolDefinition[] {
    return [
      {
        name: "Agent",
        label: "SubAgent",
        parameters: launchParameters,
        description:
          "Launch an autonomous agent for complex, multi-step tasks. Select subagent_type (default general-purpose). Use Explore for read-only codebase searches. Send independent tasks in one response to run concurrently. Agents receive only your prompt and their own instructions; provide all necessary context. Models are controlled by user settings. For background agents, continue with other work; completion is delivered automatically. Do not poll or duplicate their work. Use SendMessage with the returned agentId to continue an agent.",
        promptSnippet: "Delegate an independent task to a configured subagent",
        execute: async (_callId, params, signal, onUpdate) => {
          if (!Value.Check(launchParameters, params)) throw new Error("invalid_input: Agent 参数无效");
          signal?.throwIfAborted();
          if (this.closing) throw new Error("busy: 子智能体插件正在关闭");
          const name = params.subagent_type ?? "general-purpose";
          const profile = this.profile(parentId, name);
          const selection = profile.modelSelection ?? this.port.selection(parentId);
          const childSessionId = await this.port.create(parentId, profile, selection, params.description);
          const task: SubagentTask = {
            agentId: `agent_${randomUUID()}`,
            childSessionId,
            parentSessionId: parentId,
            parentToolCallId: _callId,
            agentType: profile.name,
            description: params.description,
            color: profile.color,
            background: params.run_in_background === true,
            status: "running",
            startedAt: Date.now(),
            modelLabel: `${selection.provider} / ${selection.modelId}`,
            totalToolUseCount: 0,
            totalTokens: 0,
          };
          this.tasks.set(task.agentId, task);
          this.childAgents.set(childSessionId, task.agentId);
          this.port.publish(task);
          onUpdate?.(result(`agentId: ${task.agentId}\nchildSessionId: ${childSessionId}`));
          const abort = () => {
            void this.stop(parentId, task.agentId).catch(() => {});
          };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) {
            await this.stop(parentId, task.agentId);
            signal.throwIfAborted();
          }
          const job = this.begin(task, params.prompt);
          if (task.background) {
            signal?.removeEventListener("abort", abort);
            return result(
              `Async agent launched successfully.\nagentId: ${task.agentId}\nchildSessionId: ${childSessionId}\nThe agent is working in the background. You will be notified automatically when it completes. Do not poll or duplicate its work.`,
            );
          }
          try {
            await job;
          } finally {
            signal?.removeEventListener("abort", abort);
          }
          signal?.throwIfAborted();
          const completed = this.tasks.get(task.agentId) as SubagentTask;
          if (completed.status === "error") throw new Error(completed.error ?? "Child runtime failed");
          return result(
            `${completed.result || "(Subagent completed but returned no output.)"}\nagentId: ${task.agentId} (use SendMessage to continue this agent)\n<usage>subagent_tokens: ${completed.totalTokens}\ntool_uses: ${completed.totalToolUseCount}\nduration_ms: ${(completed.endedAt ?? Date.now()) - completed.startedAt}</usage>`,
          );
        },
      },
      {
        name: "SendMessage",
        label: "发送消息",
        parameters: messageParameters,
        description:
          "Send a follow-up to a local agent ID returned by Agent. Running agents receive guidance at their next model/tool boundary without interrupting tools. Idle or terminal agents resume in the background. Completion is delivered automatically.",
        execute: async (_id, params, signal) => {
          if (!Value.Check(messageParameters, params)) throw new Error("invalid_input: SendMessage 参数无效");
          signal?.throwIfAborted();
          const task = this.owned(parentId, params.to);
          if (this.closing) throw new Error("busy: 子智能体插件正在关闭");
          const activeJob = this.jobs.get(task.agentId);
          const prompt = `The coordinator sent a message while you were working:\n${params.summary}\n\n${params.message}`;
          const steered = task.status === "running" && this.port.steer(task.childSessionId, prompt);
          if (!steered) {
            const profile = this.profile(parentId, task.agentType);
            const selection = profile.modelSelection ?? this.port.selection(parentId);
            const pending = this.begin(task, prompt, { profile, selection });
            void pending.catch(() => {});
          }
          return result(
            JSON.stringify({
              status: "success",
              messageId: randomUUID(),
              agentId: task.agentId,
              delivery: steered ? "steered" : activeJob ? "queued" : "resumed_background",
            }),
          );
        },
      },
      {
        name: "TaskStop",
        label: "停止子智能体",
        parameters: stopParameters,
        description:
          "Stop a running subagent by its agentId. Stops only agents belonging to this conversation.",
        execute: async (_id, params) => {
          if (!Value.Check(stopParameters, params)) throw new Error("invalid_input: TaskStop 参数无效");
          await this.stop(parentId, params.task_id);
          return result("Task stopped.");
        },
      },
    ];
  }
}
