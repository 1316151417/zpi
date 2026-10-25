// Agent launch and SendMessage contracts follow ZCode (Apache-2.0).
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

import type { ToolDefinition } from "zpi-coding-agent";
import type { SubagentTask } from "zpi-ui";
import type { CombinedSelection } from "../../../shared/bridge.ts";
import type { SubagentProfile } from "../../../shared/subagents.ts";
import { SubagentArtifacts, textResult } from "./artifacts.ts";
import type { SubagentProfiles } from "./profiles.ts";
import {
  agentDescription,
  respondToCoordinatorDescription,
  sendMessageDescription,
  taskOutputDescription,
  taskStopDescription,
} from "./prompts.ts";
import {
  type AgentBackgroundedOutput,
  completedAgentOutput,
  formatAgentOutputForModel,
  formatCoordinatorSteer,
  formatRespondToCoordinatorModelContent,
  formatSendMessageModelContent,
  formatTaskOutputModelContent,
  providerTaskStatus,
  type SendMessageOutput,
  type TaskOutputResult,
} from "./protocol.ts";
import { assertToolArguments, validateToolArguments } from "./validation.ts";

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
const result = textResult;

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
  private artifacts: SubagentArtifacts;
  constructor(profiles: SubagentProfiles, port: SubagentPort, outputRoot = join(tmpdir(), "zpi-agents")) {
    this.artifacts = new SubagentArtifacts(outputRoot);
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
    const profiles = this.definitions.get(parentId) ?? [];
    const normalize = (value: string) =>
      value
        .trim()
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\p{White_Space}\p{Pd}_]+/gu, "");
    const exact = profiles.find((profile) => profile.name === name);
    if (exact) return structuredClone(exact);
    const matches = normalize(name)
      ? profiles.filter((profile) => normalize(profile.name) === normalize(name))
      : [];
    if (matches.length === 1) return structuredClone(matches[0]);
    if (matches.length > 1)
      throw new Error(
        `Agent type '${name}' is ambiguous — matches ${matches.map((profile) => profile.name).join(", ")} — Use the exact name: ${matches.map((profile) => profile.name).join(" or ")}`,
      );
    throw new Error(
      `Agent type '${name}' not found. Available agents: ${profiles.map((profile) => profile.name).join(", ")}`,
    );
  }
  private contract(tool: ToolDefinition): ToolDefinition {
    const prepare = (args: unknown) =>
      validateToolArguments(
        tool.name,
        tool.parameters,
        tool.name === "TaskOutput" ? prepareTaskOutputArguments(args) : args,
      );
    return {
      ...tool,
      prepareArguments: prepare,
      execute: async (id, params, signal, update, context) =>
        tool.execute(id, prepare(params), signal, update, context),
    };
  }
  childTools(childId: string): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      {
        name: "RespondToCoordinator",
        label: "回复",
        parameters: responseParameters,
        description: respondToCoordinatorDescription,
        metadata: { concurrentSafe: true, sideEffectScope: "session", destructive: false },
        execute: async (_id, params, signal) => {
          assertToolArguments("RespondToCoordinator", responseParameters, params);
          signal?.throwIfAborted();
          const task = this.taskForChild(childId);
          if (!task || this.closing)
            throw new Error("Coordinator response port is not configured for RespondToCoordinator");
          const responseId = `response_${randomUUID()}`;
          let output: Parameters<typeof formatRespondToCoordinatorModelContent>[0];
          try {
            await this.port.notify(task, params);
            output = {
              status: "success" as const,
              responseId,
              message: "Response was queued for the coordinator.",
            };
          } catch (error) {
            output = {
              status: "failed" as const,
              responseId,
              message: "Response could not be queued for the coordinator.",
              error: error instanceof Error ? error.message : String(error),
            };
          }
          return this.artifacts.result(
            task.parentSessionId,
            _id,
            "RespondToCoordinator",
            formatRespondToCoordinatorModelContent(output),
            output,
          );
        },
      },
    ];
    return tools.map((tool) => this.contract(tool));
  }
  list(parentId: string) {
    return structuredClone([...this.tasks.values()].filter((task) => task.parentSessionId === parentId));
  }
  restore(task: SubagentTask) {
    this.childAgents.set(task.childSessionId, task.agentId);
    this.tasks.set(task.agentId, {
      ...this.artifacts.paths(task.parentSessionId, task.agentId),
      ...task,
      spawnToolCallId: task.spawnToolCallId ?? task.parentToolCallId,
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
      // A completed UI card must not precede its output files and durable inbox delivery.
      // Stops remain synchronous so a publication failure cannot skip cancellation.
      if (!this.jobs.has(agentId) || !["completed", "error"].includes(next.status)) this.port.publish(next);
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
          this.update(agentId, {
            status: "aborted",
            endedAt: Date.now(),
            waitingForInput: false,
            error: "Background agent task stopped.",
          });
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
        const latest = this.tasks.get(agentId);
        if (latest) await this.artifacts.finish(latest);
        if (publicationError) throw publicationError;
      })
      .finally(() => {
        this.stopping.delete(agentId);
      });
    this.stopping.set(agentId, stopped);
    return stopped;
  }
  async stopAll(parentId: string) {
    const tasks = this.list(parentId);
    await Promise.all(
      tasks.filter((task) => task.status === "running").map((task) => this.stop(parentId, task.agentId)),
    );
    await Promise.allSettled(tasks.map((task) => this.jobs.get(task.agentId)));
  }
  async close() {
    this.closing = true;
    await Promise.all(
      [...this.tasks.values()]
        .filter((task) => task.status === "running")
        .map((task) => this.stop(task.parentSessionId, task.agentId)),
    );
    await Promise.allSettled([...this.jobs.values()]);
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
        totalTokens: 0,
        tokensReported: false,
        totalToolUseCount: 0,
        usage: undefined,
        prompt,
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
        const current = this.tasks.get(task.agentId) ?? task;
        if (resume) await this.artifacts.metadata(current, resume.profile);
        await this.port.run(task.childSessionId, prompt, resume?.profile, resume?.selection);
      } catch (error) {
        if (this.tasks.get(task.agentId)?.status !== "aborted")
          this.update(task.agentId, {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            endedAt: Date.now(),
          });
      }
      const latest = this.tasks.get(task.agentId);
      if (latest && this.jobs.get(task.agentId) === done && latest.status !== "running")
        await this.artifacts.finish(latest);
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
      if (latest && latest.status !== "running" && this.tasks.get(task.agentId) === latest)
        this.port.publish(latest);
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
    const tools: ToolDefinition[] = [
      {
        name: "Agent",
        label: "子智能体",
        parameters: launchParameters,
        description: agentDescription,
        execute: async (_callId, params, signal, onUpdate, context) => {
          assertToolArguments("Agent", launchParameters, params);
          signal?.throwIfAborted();
          if (this.closing) throw new Error("busy: 子智能体插件正在关闭");
          const name = params.subagent_type ?? "general-purpose";
          const profile = this.profile(parentId, name);
          const selection = profile.modelSelection ?? this.port.selection(parentId);
          const childSessionId = await this.port.create(parentId, profile, selection, params.description);
          const agentId = `agent_${randomUUID()}`;
          const task: SubagentTask = {
            agentId,
            ...this.artifacts.paths(parentId, agentId),
            prompt: params.prompt,
            cwd: this.port.cwd(parentId),
            childSessionId,
            parentSessionId: parentId,
            parentToolCallId: _callId,
            spawnToolCallId: _callId,
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
          await this.artifacts.metadata(task, profile);
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
            const tools = context?.getToolNames?.() ?? ["read", "bash"];
            const output: AgentBackgroundedOutput = {
              status: "async_launched",
              isAsync: true,
              agentId: task.agentId,
              agentType: task.agentType,
              description: task.description,
              prompt: params.prompt,
              childSessionId,
              backgroundTaskId: task.agentId,
              outputFile: task.outputFile as string,
              canReadOutputFile: tools.some((name) => ["Read", "Bash", "read", "bash"].includes(name)),
            };
            return this.artifacts.result(
              parentId,
              _callId,
              "Agent",
              formatAgentOutputForModel(output),
              output,
            );
          }
          try {
            await job;
          } finally {
            signal?.removeEventListener("abort", abort);
          }
          signal?.throwIfAborted();
          const completed = this.tasks.get(task.agentId) as SubagentTask;
          if (completed.status !== "completed")
            throw new Error(completed.error ?? "Background agent task stopped.");
          const output = completedAgentOutput(completed);
          return this.artifacts.result(parentId, _callId, "Agent", formatAgentOutputForModel(output), output);
        },
      },
      {
        name: "SendMessage",
        label: "发送消息",
        parameters: messageParameters,
        description: sendMessageDescription,
        execute: async (_id, params, signal) => {
          assertToolArguments("SendMessage", messageParameters, params);
          const messageId = `msg_${randomUUID()}`;
          const failure = (error: string) => {
            const output: SendMessageOutput = {
              status: "failed",
              messageId,
              agentId: params.to,
              error,
              message: error,
            };
            return this.artifacts.result(
              parentId,
              _id,
              "SendMessage",
              formatSendMessageModelContent(output),
              output,
            );
          };
          if (signal?.aborted || this.closing || this.stopping.has(params.to))
            return failure(`SendMessage was aborted for ${params.to}.`);
          const task = this.tasks.get(params.to);
          if (!task || task.parentSessionId !== parentId)
            return failure(`No active local_agent task found for target ${params.to}.`);
          const prompt = params.summary?.trim()
            ? `${params.summary.trim()}\n\n${params.message}`
            : params.message;
          let delivery: "queued" | "steered" | "resumed_background";
          let message: string;
          if (task.status === "running") {
            let steered = false;
            try {
              steered = this.port.steer(task.childSessionId, formatCoordinatorSteer(prompt));
            } catch {
              // ZCode retains the message for the next tool round when steering rejects.
            }
            if (!steered) {
              const profile = this.profile(parentId, task.agentType);
              const selection = profile.modelSelection ?? this.port.selection(parentId);
              void this.begin(task, formatCoordinatorSteer(prompt), { profile, selection }).catch(() => {});
            }
            delivery = steered ? "steered" : "queued";
            message = steered
              ? `Message ${messageId} was sent to its active turn for local agent ${task.agentId}.`
              : `Message queued for delivery to ${task.agentId} at its next tool round.`;
          } else {
            let profile: SubagentProfile;
            try {
              profile = this.profile(parentId, task.agentType);
            } catch {
              return failure(
                `Cannot resume local agent ${task.agentId}: profile ${task.agentType} is unavailable.`,
              );
            }
            if (!task.childSessionId)
              return failure(`Cannot resume local agent ${task.agentId}: missing child session id.`);
            const selection = profile.modelSelection ?? this.port.selection(parentId);
            const status = providerTaskStatus(task);
            this.update(task.agentId, {
              description: params.summary || task.description,
              parentToolCallId: _id,
            });
            void this.begin(task, params.message, { profile, selection }).catch(() => {});
            delivery = "resumed_background";
            message = `Agent "${task.agentId}" was stopped (${status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${task.outputFile}`;
          }
          const output: SendMessageOutput = {
            status: "success",
            messageId,
            agentId: task.agentId,
            taskId: task.agentId,
            outputFile: task.outputFile,
            delivery,
            message,
          };
          return this.artifacts.result(
            parentId,
            _id,
            "SendMessage",
            formatSendMessageModelContent(output),
            output,
          );
        },
      },
      {
        name: "TaskOutput",
        label: "查看子智能体输出",
        parameters: outputParameters,
        description: taskOutputDescription,
        metadata: { concurrentSafe: true, sideEffectScope: "session", destructive: false },

        execute: async (_id, params, signal) => {
          assertToolArguments("TaskOutput", outputParameters, params);
          signal?.throwIfAborted();
          if (!params.task_id) throw new Error("<tool_use_error>Task ID is required</tool_use_error>");
          const owned = this.tasks.get(params.task_id);
          if (!owned || owned.parentSessionId !== parentId)
            throw new Error(`<tool_use_error>No task found with ID: ${params.task_id}</tool_use_error>`);
          if (params.block) await this.waitForOutput(parentId, params.task_id, params.timeout, signal);
          signal?.throwIfAborted();
          const task = this.tasks.get(params.task_id);
          if (!task) {
            const output: TaskOutputResult = { retrieval_status: "timeout", task: null };
            return this.artifacts.result(
              parentId,
              _id,
              "TaskOutput",
              formatTaskOutputModelContent(output),
              output,
            );
          }
          const diskOutput = await this.artifacts.read(task.outputFile, signal);
          const clean = task.status === "completed" ? task.result : undefined;
          const text = clean || diskOutput;
          const output: TaskOutputResult = {
            retrieval_status:
              task.status === "running" ? (params.block ? "timeout" : "not_ready") : "success",
            task: {
              task_id: task.agentId,
              task_type: "local_agent",
              status: providerTaskStatus(task),
              description: task.description,
              output: text,
              ...(task.outputFile ? { outputFile: task.outputFile } : {}),
              ...(task.prompt ? { prompt: task.prompt } : {}),
              ...(text ? { result: text } : {}),
              ...(task.error ? { error: task.error } : {}),
            },
          };
          signal?.throwIfAborted();
          const projected = await this.artifacts.result(
            parentId,
            _id,
            "TaskOutput",
            formatTaskOutputModelContent(output),
            output,
          );
          signal?.throwIfAborted();
          if (output.retrieval_status === "success") this.notified.add(task);
          return projected;
        },
      },
      {
        name: "TaskStop",
        label: "停止子智能体",
        parameters: stopParameters,
        description: taskStopDescription,
        execute: async (_id, params, signal) => {
          assertToolArguments("TaskStop", stopParameters, params);
          signal?.throwIfAborted();
          const taskId = params.task_id ?? params.shell_id;
          if (!taskId) throw new Error("Missing required parameter: task_id");
          const task = this.tasks.get(taskId);
          if (!task || task.parentSessionId !== parentId)
            throw new Error(
              `Invalid task ID "${taskId}". This lookup failure does not mean the task has completed or stopped; use the full task_id returned when the task started to stop it.`,
            );
          if (task.status !== "running")
            throw new Error(`Task ${taskId} is not running (status: ${providerTaskStatus(task)})`);
          await this.stop(parentId, taskId);
          const stopped = this.tasks.get(taskId);
          if (stopped?.background && !this.closing && !this.notified.has(stopped)) {
            await this.port.notify(stopped);
            this.notified.add(stopped);
          }
          const output = {
            message: `Successfully stopped task: ${task.agentId} (${task.description})`,
            task_id: task.agentId,
            task_type: "local_agent",
            command: task.description,
          };
          return this.artifacts.result(parentId, _id, "TaskStop", JSON.stringify(output), output);
        },
      },
    ];
    return tools.map((tool) => this.contract(tool));
  }
}
