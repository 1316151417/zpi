// Agent launch and SendMessage contracts follow ZCode (Apache-2.0).
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolDefinition } from "zpi-coding-agent";
import type { SubagentTask } from "zpi-ui";
import type { CombinedSelection } from "../../../shared/bridge.ts";
import type { SubagentProfile } from "../../../shared/subagents.ts";
import type { SubagentProfiles } from "./profiles.ts";
import {
  agentDescription,
  respondToCoordinatorDescription,
  sendMessageDescription,
  taskOutputDescription,
  taskStopDescription,
} from "./prompts.ts";

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
      description: "A short (3-5 word) description of the task",
    }),
    prompt: Type.String({
      description: "The task for the agent to perform",
    }),
    subagent_type: Type.Optional(
      Type.String({ description: "The type of specialized agent to use for this task" }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description:
          "Set to true to run this agent in the background. You will be notified when it completes.",
      }),
    ),
  },
  { additionalProperties: false },
);
const messageParameters = Type.Object(
  {
    to: Type.String({
      minLength: 1,
      maxLength: 200,
      description: "Recipient: local agent ID returned by Agent (format agent_<uuid>).",
    }),
    summary: Type.String({
      minLength: 1,
      maxLength: 200,
      description: "A 5-10 word summary shown as a preview in the UI.",
    }),
    message: Type.String({ minLength: 1, maxLength: 20000, description: "Plain text message content" }),
  },
  { additionalProperties: false },
);
const responseParameters = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: 200, description: "Short summary of the response." }),
    message: Type.String({
      minLength: 1,
      maxLength: 20000,
      description: "Response or progress update for the coordinator.",
    }),
  },
  { additionalProperties: false },
);
const stopParameters = Type.Object(
  {
    task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
    shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
  },
  { additionalProperties: false },
);
const outputParameters = Type.Object(
  {
    task_id: Type.String({ description: "The task ID to get output from" }),
    block: Type.Boolean({ default: true, description: "Whether to wait for completion" }),
    timeout: Type.Number({ minimum: 0, maximum: 600000, default: 30000, description: "Max wait time in ms" }),
  },
  { additionalProperties: false },
);
export function prepareTaskOutputArguments(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const input = args as Record<string, unknown>;
  return {
    ...input,
    block:
      input.block === undefined || input.block === "true"
        ? true
        : input.block === "false"
          ? false
          : input.block,
    timeout: input.timeout === undefined ? 30000 : input.timeout,
  };
}
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

export class SubagentPlugin {
  readonly tasks = new Map<string, SubagentTask>();
  private childAgents = new Map<string, string>();
  private jobs = new Map<string, Promise<void>>();
  private pendingRuns = new Map<string, number>();
  private stopping = new Map<string, Promise<void>>();
  private outputWaiters = new Map<string, Set<() => void>>();
  private notified = new WeakSet<SubagentTask>();
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
        description: respondToCoordinatorDescription,
        metadata: { concurrentSafe: true, sideEffectScope: "session", destructive: false },
        execute: async (_id, params, signal) => {
          if (!Value.Check(responseParameters, params))
            throw new Error("invalid_input: RespondToCoordinator 参数无效");
          signal?.throwIfAborted();
          const task = this.taskForChild(childId);
          if (!task || this.closing)
            throw new Error("configuration: Coordinator response port is not configured");
          const responseId = `response_${randomUUID()}`;
          const continuation =
            "Continue the current task unless the coordinator explicitly changed or ended it.";
          try {
            await this.port.notify(task, params);
            return result(`Response ${responseId} was queued for the coordinator. ${continuation}`);
          } catch (error) {
            return {
              ...result(
                `Response ${responseId} failed to queue for the coordinator. ${continuation} Failure: ${error instanceof Error ? error.message : String(error)}.`,
              ),
              isError: true,
            };
          }
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
        this.cancellations.delete(task.agentId);
        this.outputWaiters.get(task.agentId)?.forEach((wake) => {
          wake();
        });
      }
  }
  update(agentId: string, fields: Partial<SubagentTask>) {
    const previous = this.tasks.get(agentId);
    if (!previous) return;
    // An earlier turn must not expose a terminal result while a follow-up still owns this agent.
    if (
      fields.status &&
      fields.status !== "running" &&
      fields.status !== "aborted" &&
      (this.pendingRuns.get(agentId) ?? 0) > 1
    )
      fields = { ...fields, status: "running", result: undefined, error: undefined, endedAt: undefined };
    if (Object.entries(fields).every(([key, value]) => previous[key as keyof SubagentTask] === value)) return;
    const next = { ...previous, ...fields };
    this.tasks.set(agentId, next);
    try {
      this.port.publish(next);
    } finally {
      // Readers observe the terminal in-memory owner even if persistence failed.
      this.outputWaiters.get(agentId)?.forEach((wake) => {
        wake();
      });
    }
  }
  private owned(parentId: string, agentId: string) {
    const task = this.tasks.get(agentId);
    if (!task || task.parentSessionId !== parentId) throw new Error("not_found: 子智能体不属于当前会话");
    return task;
  }
  async stop(parentId: string, agentId: string) {
    const task = this.owned(parentId, agentId);
    const stopping = this.stopping.get(agentId);
    if (stopping) return stopping;
    if (task.status !== "running") throw new Error("busy: 子智能体已结束");
    this.cancellations.set(agentId, (this.cancellations.get(agentId) ?? 0) + 1);
    const job = this.jobs.get(agentId);
    const stopped = Promise.resolve()
      .then(async () => {
        let publicationError: unknown;
        // Mark before cancelling so completion cannot publish a successful result, but
        // a failed persistence/UI publication must never skip actual cancellation.
        try {
          this.update(agentId, { status: "aborted", endedAt: Date.now(), waitingForInput: false });
        } catch (error) {
          publicationError = error;
        }
        try {
          await this.port.stop(task.childSessionId);
        } catch (error) {
          // Cancellation is unconfirmed. Keep the owner retryable rather than
          // treating potentially live work as terminal forever.
          if (this.tasks.get(agentId)?.status === "aborted") {
            try {
              this.update(agentId, { status: "running", endedAt: undefined });
            } catch {
              // update changes the in-memory owner before publishing.
            }
          }
          throw error;
        }
        await job?.catch(() => {});
        if (publicationError) throw publicationError;
      })
      .finally(() => {
        this.stopping.delete(agentId);
      });
    this.stopping.set(agentId, stopped);
    return stopped;
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
    if (resume) {
      this.update(task.agentId, {
        background: true,
        status: "running",
        startedAt: Date.now(),
        endedAt: undefined,
        error: undefined,
        latestActivity: undefined,
        result: undefined,
        waitingForInput: false,
      });
    }
    this.pendingRuns.set(task.agentId, (this.pendingRuns.get(task.agentId) ?? 0) + 1);
    let done!: Promise<void>;
    done = (async () => {
      if (previous) await previous.catch(() => {});
      if (
        this.closing ||
        generation !== (this.cancellations.get(task.agentId) ?? 0) ||
        (!resume && this.tasks.get(task.agentId)?.status === "aborted")
      )
        return;
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
        latest.status !== "running" &&
        latest.status !== "aborted" &&
        !this.notified.has(latest) &&
        !this.closing
      ) {
        await this.port.notify(latest);
        this.notified.add(latest);
      }
    })().finally(() => {
      const pending = (this.pendingRuns.get(task.agentId) ?? 1) - 1;
      if (pending) this.pendingRuns.set(task.agentId, pending);
      else this.pendingRuns.delete(task.agentId);
      if (this.jobs.get(task.agentId) === done) this.jobs.delete(task.agentId);
    });
    this.jobs.set(task.agentId, done);
    void done.catch(() => {});
    return done;
  }
  private waitForOutput(parentId: string, agentId: string, timeout: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.owned(parentId, agentId).status !== "running" || timeout === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const listeners = this.outputWaiters.get(agentId) ?? new Set<() => void>();
      this.outputWaiters.set(agentId, listeners);
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        listeners.delete(wake);
        if (!listeners.size) this.outputWaiters.delete(agentId);
        if (error) reject(error);
        else resolve();
      };
      const wake = () => {
        if (this.tasks.get(agentId)?.status !== "running") finish();
      };
      const abort = () => finish(signal?.reason ?? new Error("TaskOutput cancelled"));
      const timer = setTimeout(finish, timeout);
      listeners.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  tools(parentId: string): ToolDefinition[] {
    return [
      {
        name: "Agent",
        label: "子智能体",
        parameters: launchParameters,
        description: agentDescription,
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
          if (signal?.aborted || this.closing) {
            await this.stop(parentId, task.agentId);
            signal?.removeEventListener("abort", abort);
            signal?.throwIfAborted();
            throw new Error("busy: 子智能体插件正在关闭");
          }
          const job = this.begin(task, params.prompt);
          if (task.background) {
            signal?.removeEventListener("abort", abort);
            return result(
              `Async agent launched successfully.\nagentId: ${task.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${task.agentId}' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.\nDo not duplicate this agent's work - avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.`,
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
            `${completed.result || "(Subagent completed but returned no output.)"}\nagentId: ${task.agentId} (use SendMessage with to: '${completed.agentId}' to continue this agent)\n<usage>subagent_tokens: ${completed.totalTokens}\ntool_uses: ${completed.totalToolUseCount}\nduration_ms: ${(completed.endedAt ?? Date.now()) - completed.startedAt}</usage>`,
          );
        },
      },
      {
        name: "SendMessage",
        label: "发送消息",
        parameters: messageParameters,
        description: sendMessageDescription,
        execute: async (_id, params, signal) => {
          if (!Value.Check(messageParameters, params)) throw new Error("invalid_input: SendMessage 参数无效");
          signal?.throwIfAborted();
          const task = this.owned(parentId, params.to);
          if (this.closing) throw new Error("busy: 子智能体插件正在关闭");
          if (this.stopping.has(task.agentId)) throw new Error("busy: 子智能体正在停止");
          const activeJob = this.jobs.get(task.agentId);
          const prompt = `The coordinator sent a message while you were working:\n${params.summary}\n\n${params.message}`;
          const steered = task.status === "running" && this.port.steer(task.childSessionId, prompt);
          if (!steered) {
            const profile = this.profile(parentId, task.agentType);
            const selection = profile.modelSelection ?? this.port.selection(parentId);
            const pending = this.begin(task, prompt, { profile, selection });
            void pending.catch(() => {});
          }
          const delivery = steered ? "steered" : activeJob ? "queued" : "resumed_background";
          return result(`Message ${randomUUID()} was ${delivery} for local agent ${task.agentId}.`);
        },
      },
      {
        name: "TaskOutput",
        label: "查看子智能体输出",
        parameters: outputParameters,
        description: taskOutputDescription,
        metadata: { concurrentSafe: true, sideEffectScope: "session", destructive: false },
        prepareArguments: (args) =>
          prepareTaskOutputArguments(args) as { task_id: string; block: boolean; timeout: number },
        execute: async (_id, params, signal) => {
          params = prepareTaskOutputArguments(params) as typeof params;
          if (!Value.Check(outputParameters, params)) throw new Error("invalid_input: TaskOutput 参数无效");
          signal?.throwIfAborted();
          this.owned(parentId, params.task_id);
          if (params.block !== false)
            await this.waitForOutput(parentId, params.task_id, params.timeout ?? 30000, signal);
          signal?.throwIfAborted();
          const task = this.owned(parentId, params.task_id);
          const status =
            task.status === "running" ? (params.block === false ? "not_ready" : "timeout") : "success";
          const output = task.result ?? task.latestActivity ?? "";
          if (status === "success") this.notified.add(task);
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `<retrieval_status>${status}</retrieval_status>`,
                  `<task_id>${task.agentId}</task_id>`,
                  "<task_type>local_agent</task_type>",
                  `<status>${task.status}</status>`,
                  ...(output.trim() ? [`<output>\n${output.trimEnd()}\n</output>`] : []),
                  ...(task.error ? [`<error>${task.error}</error>`] : []),
                ].join("\n\n"),
              },
            ],
            details: {
              retrieval_status: status,
              task: {
                task_id: task.agentId,
                task_type: "local_agent",
                status: task.status,
                description: task.description,
                output,
                ...(task.error ? { error: task.error } : {}),
              },
            },
          };
        },
      },
      {
        name: "TaskStop",
        label: "停止子智能体",
        parameters: stopParameters,
        description: taskStopDescription,
        execute: async (_id, params, signal) => {
          if (!Value.Check(stopParameters, params)) throw new Error("invalid_input: TaskStop 参数无效");
          signal?.throwIfAborted();
          const taskId = params.task_id ?? params.shell_id;
          if (!taskId) throw new Error("Missing required parameter: task_id");
          const task = this.tasks.get(taskId);
          if (!task || task.parentSessionId !== parentId)
            throw new Error(
              `Invalid task ID "${taskId}". This lookup failure does not mean the task has completed or stopped; use the full task_id returned when the task started to stop it.`,
            );
          if (task.status !== "running")
            throw new Error(`Task ${taskId} is not running (status: ${task.status})`);
          await this.stop(parentId, taskId);
          return result(
            JSON.stringify({
              message: `Successfully stopped task: ${task.agentId} (${task.description})`,
              task_id: task.agentId,
              task_type: "local_agent",
              command: task.description,
            }),
          );
        },
      },
    ];
  }
}
