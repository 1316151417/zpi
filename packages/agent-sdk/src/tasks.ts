import { randomUUID } from "node:crypto";
import { type TObject, Type } from "typebox";
import { abortable } from "zpi-ai";
import type { ToolDefinition } from "zpi-coding-agent";

interface Task {
  id: string;
  controller: AbortController;
  done: Promise<string>;
  status: "running" | "completed" | "failed" | "stopped";
  output: string;
}
export class Tasks {
  private tasks = new Map<string, Task>();
  start(run: (signal: AbortSignal) => Promise<string>): string {
    const task: Task = {
      id: randomUUID(),
      controller: new AbortController(),
      status: "running",
      output: "",
      done: Promise.resolve(""),
    };
    this.tasks.set(task.id, task);
    task.done = Promise.resolve()
      .then(() => run(task.controller.signal))
      .then(
        (output) => {
          task.output = output;
          task.status = task.controller.signal.aborted ? "stopped" : "completed";
          return output;
        },
        (error) => {
          task.status = task.controller.signal.aborted ? "stopped" : "failed";
          task.output = String(error);
          return task.output;
        },
      );
    return task.id;
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
        execute: async (_id, input) => {
          const task = this.tasks.get(input.task_id as string);
          if (!task) throw new Error("Unknown task_id");
          task.controller.abort();
          await task.done;
          return { content: [{ type: "text", text: `Stopped ${task.id}` }], details: undefined };
        },
      },
    ];
  }
  async close(): Promise<void> {
    for (const task of this.tasks.values()) task.controller.abort();
    try {
      await Promise.all([...this.tasks.values()].map((task) => task.done));
    } finally {
      this.tasks.clear();
    }
  }
}
