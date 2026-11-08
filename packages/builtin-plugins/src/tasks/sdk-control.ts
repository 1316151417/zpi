import { randomUUID } from "node:crypto";
import type { HostTaskControl, SDKTaskMessage } from "@zpi-dev/agent-sdk";
import type { BackgroundTask, SubagentTask } from "../types.ts";
import { type TaskBackend, TaskControls } from "./controls.ts";

type Task = BackgroundTask | SubagentTask;
/** A subscription projection only. Execution and ownership remain in the existing backends. */
export class SdkTaskControl implements HostTaskControl {
  private controls: TaskControls;
  private listeners = new Map<string, Set<(task: Task) => void>>();
  private snapshot: (sessionId: string) => Task[];
  constructor(backends: readonly TaskBackend[], snapshot: (sessionId: string) => Task[]) {
    this.controls = new TaskControls(backends);
    this.snapshot = snapshot;
  }
  async stopTask(sessionId: string, taskId: string, signal: AbortSignal): Promise<void> {
    await this.controls.stop(sessionId, randomUUID(), taskId, signal);
  }
  publish(task: Task): void {
    const owner = "agentId" in task ? task.parentSessionId : task.sessionId;
    for (const listener of this.listeners.get(owner) ?? []) listener(task);
  }
  subscribe(sessionId: string, listener: (message: SDKTaskMessage) => void): () => void {
    const started = new Set<string>(),
      terminal = new Set<string>();
    const project = (task: Task) => {
      const agent = "agentId" in task;
      const id = agent ? task.agentId : task.taskId;
      const runId = String(task.startedAt).padStart(16, "0"),
        runKey = `${id}:${runId}`;
      if (terminal.has(runKey)) return;
      const base = {
        type: "system" as const,
        uuid: randomUUID(),
        session_id: sessionId,
        task_id: id,
        run_id: runId,
        tool_use_id: agent ? task.parentToolCallId : task.toolCallId,
      };
      if (!started.has(runKey)) {
        started.add(runKey);
        listener({
          ...base,
          subtype: "task_started",
          description: task.description,
          task_type: agent ? "local_agent" : "local_bash",
          is_backgrounded: agent ? task.background : true,
          ...(agent ? { subagent_type: task.agentType } : {}),
        });
      }
      const usage = {
        total_tokens: agent ? task.totalTokens : 0,
        tool_uses: agent ? task.totalToolUseCount : 0,
        duration_ms: Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt),
      };
      if (task.status === "running")
        listener({
          ...base,
          uuid: randomUUID(),
          subtype: "task_progress",
          description: task.description,
          usage,
          ...(agent ? { summary: task.latestActivity } : {}),
        });
      else {
        terminal.add(runKey);
        listener({
          ...base,
          uuid: randomUUID(),
          subtype: "task_notification",
          status:
            task.status === "completed"
              ? "completed"
              : ["failed", "error", "lost"].includes(task.status)
                ? "failed"
                : "stopped",
          output_file: agent ? (task.outputFile ?? "") : task.outputPath,
          summary: (agent ? task.result : undefined) ?? task.error ?? task.description,
          usage,
        });
      }
    };
    let listeners = this.listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(sessionId, listeners);
    }
    listeners.add(project);
    for (const task of this.snapshot(sessionId)) if (task.status === "running") project(task);
    return () => {
      listeners.delete(project);
      if (!listeners.size) this.listeners.delete(sessionId);
    };
  }
}
