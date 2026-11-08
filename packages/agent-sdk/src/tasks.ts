import { randomUUID } from "node:crypto";
import { abortable } from "@zpi-dev/ai";
import type { ToolDefinition } from "@zpi-dev/coding-agent";
import { type TObject, Type } from "typebox";

export interface TaskMetadata {
  description?: string;
  toolUseId?: string;
  taskType?: string;
  subagentType?: string;
}
export interface TaskEvent extends TaskMetadata {
  id: string;
  phase: "started" | "progress" | "terminal";
  status: "running" | "completed" | "failed" | "stopped";
  output: string;
  startedAt: number;
  totalTokens: number;
  toolUses: number;
}
interface Task extends TaskEvent {
  controller: AbortController;
  done: Promise<string>;
}
export class Tasks {
  private tasks = new Map<string, Task>();
  private closed = false;
  private listener?: (event: TaskEvent) => void;
  constructor(listener?: (event: TaskEvent) => void) {
    this.listener = listener;
  }
  start(
    run: (
      signal: AbortSignal,
      progress: (output: string, totalTokens?: number, toolUses?: number) => void,
    ) => Promise<string>,
    metadata: TaskMetadata = {},
  ): string {
    if (this.closed) throw new Error("Tasks are closed");
    const task: Task = {
      ...metadata,
      phase: "started",
      startedAt: Date.now(),
      totalTokens: 0,
      toolUses: 0,
      id: randomUUID(),
      controller: new AbortController(),
      status: "running",
      output: "",
      done: Promise.resolve(""),
    };
    this.tasks.set(task.id, task);
    this.emit(task);
    task.done = Promise.resolve()
      .then(() =>
        run(task.controller.signal, (output, totalTokens, toolUses) => {
          if (task.status !== "running") return;
          task.output = output;
          task.totalTokens = totalTokens ?? task.totalTokens;
          task.toolUses = toolUses ?? task.toolUses;
          task.phase = "progress";
          this.emit(task);
        }),
      )
      .then(
        (output) => {
          task.output = output;
          task.status = task.controller.signal.aborted ? "stopped" : "completed";
          task.phase = "terminal";
          this.emit(task);
          return output;
        },
        (error) => {
          task.status = task.controller.signal.aborted ? "stopped" : "failed";
          task.output = String(error);
          task.phase = "terminal";
          this.emit(task);
          return task.output;
        },
      );
    return task.id;
  }
  private emit(task: Task): void {
    const { controller: _, done: __, ...event } = task;
    this.listener?.(event);
  }
  async stop(id: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Tasks are closed");
    const task = this.tasks.get(id);
    if (!task) throw new Error("Unknown task_id");
    if (task.status !== "running") return;
    task.controller.abort();
    await (signal ? abortable(task.done, signal) : task.done);
  }
  tools(): ToolDefinition<TObject>[] {
    return [
      {
        name: "TaskOutput",
        label: "TaskOutput",
        description: "Read a background task's output. Optionally wait for completion.",
        parameters: Type.Object({
          task_id: Type.String(),
          block: Type.Optional(Type.Boolean()),
          timeout: Type.Optional(Type.Integer({ minimum: 0, maximum: 600000 })),
        }),
        execute: async (_id, input, signal) => {
          const task = this.tasks.get(input.task_id as string);
          if (!task) throw new Error("Unknown task_id");
          if (input.block !== false && task.status === "running") {
            const timer = AbortSignal.timeout(Number(input.timeout ?? 30000));
            try {
              await abortable(task.done, signal ? AbortSignal.any([timer, signal]) : timer);
            } catch (error) {
              if (signal?.aborted) throw error;
            }
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ task_id: task.id, status: task.status, output: task.output }),
              },
            ],
            details: undefined,
          };
        },
      },
      {
        name: "TaskStop",
        label: "TaskStop",
        description: "Stop a background task owned by this query.",
        parameters: Type.Object({ task_id: Type.String() }),
        execute: async (_id, input, signal) => {
          await this.stop(input.task_id as string, signal);
          return { content: [{ type: "text", text: `Stopped ${input.task_id}` }], details: undefined };
        },
      },
    ];
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.tasks.values()) task.controller.abort();
    try {
      await Promise.all([...this.tasks.values()].map((task) => task.done));
    } finally {
      this.tasks.clear();
    }
  }
}
