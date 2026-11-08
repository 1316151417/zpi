// Shared task-control contracts; backends own execution, state and session isolation.

import type { AgentToolResult } from "@zpi-dev/agent";
import type { ToolDefinition } from "@zpi-dev/coding-agent";
import { Type } from "typebox";
import { validateToolArguments } from "../tool-validation.ts";

export interface TaskOutputInput {
  task_id: string;
  block: boolean;
  timeout: number;
}
export interface TaskBackend {
  kind: string;
  owns(sessionId: string, taskId: string): boolean;
  output(
    sessionId: string,
    callId: string,
    input: TaskOutputInput,
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
  stop(sessionId: string, callId: string, taskId: string, signal?: AbortSignal): Promise<AgentToolResult>;
}
export const stopParameters = Type.Object(
  {
    task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
    shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
  },
  { additionalProperties: false },
);
export const outputParameters = Type.Object(
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
export const taskStopDescription =
  "\n- Stops a running background task by its ID\n- Takes a task_id parameter identifying the task to stop\n- Returns a success or failure status\n- Use this tool when you need to terminate a long-running task\n";
export const taskOutputDescription =
  "DEPRECATED: Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes.\n- For bash tasks: prefer using the Read tool on that output file path \u2014 it contains stdout/stderr.\n- For local_agent tasks: use the Agent tool result directly. Do NOT Read the .output file \u2014 it is a symlink to the full subagent conversation transcript (JSONL) and will overflow your context window.\n- For remote_agent tasks: prefer using the Read tool on the output file path \u2014 it contains the streamed remote session output (same as bash).\n\n- Retrieves output from a running or completed task (background shell, agent, or remote session)\n- Takes a task_id parameter identifying the task\n- Returns the task output along with status information\n- Use block=true (default) to wait for task completion\n- Use block=false for non-blocking check of current status\n- Task IDs can be found using the /tasks command\n- Works with all task types: background shells, async agents, and remote sessions";

export class TaskControls {
  private backends: readonly TaskBackend[];
  constructor(backends: readonly TaskBackend[]) {
    if (new Set(backends.map((backend) => backend.kind)).size !== backends.length)
      throw new Error("Duplicate task backend");
    this.backends = [...backends];
  }
  private backend(sessionId: string, taskId: string, action: string): TaskBackend {
    const matches = this.backends.filter((backend) => backend.owns(sessionId, taskId));
    if (matches.length > 1) throw new Error("Ambiguous task ownership");
    if (!matches.length)
      throw new Error(
        action === "TaskOutput"
          ? `<tool_use_error>No task found with ID: ${taskId}</tool_use_error>`
          : `Invalid task ID "${taskId}". This lookup failure does not mean the task has completed or stopped; use the full task_id returned when the task started to stop it.`,
      );
    return matches[0];
  }
  tools(sessionId: string): ToolDefinition[] {
    const prepareOutput = (input: unknown) =>
      validateToolArguments("TaskOutput", outputParameters, prepareTaskOutputArguments(input));
    const prepareStop = (input: unknown) => validateToolArguments("TaskStop", stopParameters, input);
    return [
      {
        name: "TaskOutput",
        label: "查看任务输出",
        parameters: outputParameters,
        description: taskOutputDescription,
        metadata: { concurrentSafe: true, sideEffectScope: "session", destructive: false },
        prepareArguments: prepareOutput,
        execute: async (callId, args, signal) => {
          const input = prepareOutput(args) as TaskOutputInput;
          signal?.throwIfAborted();
          if (!input.task_id) throw new Error("<tool_use_error>Task ID is required</tool_use_error>");
          return this.backend(sessionId, input.task_id, "TaskOutput").output(
            sessionId,
            callId,
            input,
            signal,
          );
        },
      },
      {
        name: "TaskStop",
        label: "停止任务",
        parameters: stopParameters,
        description: taskStopDescription,
        prepareArguments: prepareStop,
        execute: async (callId, args, signal) => {
          const input = prepareStop(args) as { task_id?: string; shell_id?: string };
          signal?.throwIfAborted();
          const taskId = input.task_id ?? input.shell_id;
          if (!taskId) throw new Error("Missing required parameter: task_id");
          return this.backend(sessionId, taskId, "TaskStop").stop(sessionId, callId, taskId, signal);
        },
      },
    ];
  }
}
