import { randomUUID } from "node:crypto";
import type { BuiltinPluginPorts, PluginInput, PluginRun } from "../ports.ts";
import type { SubagentTask } from "../types.ts";
import { agentTaskNotification, escapeXml, formatAgentIncoming, formatSubagentMessage } from "./protocol.ts";

export class CollaborationInbox {
  private readonly pending = new Map<string, PluginInput[]>();
  private readonly offered = new WeakMap<PluginRun, Set<PluginInput>>();
  private readonly ports: Pick<BuiltinPluginPorts, "storage" | "sessions">;
  private readonly isChild: (id: string) => boolean;
  constructor(ports: Pick<BuiltinPluginPorts, "storage" | "sessions">, isChild: (id: string) => boolean) {
    this.ports = ports;
    this.isChild = isChild;
  }
  guidance(id: string, text: string): boolean {
    const active = this.ports.sessions.active(id);
    if (!active || active.aborted) return false;
    if (active.session?.steer(text)) return true;
    const pending = this.pending.get(id) ?? [];
    pending.push({ sessionId: id, text });
    this.pending.set(id, pending);
    return true;
  }
  restore(id: string, queued: PluginInput[]): void {
    if (!queued.length) return;
    const pending = new Set(queued.map((input) => input.deliveryId ?? input.text));
    const history = this.ports.sessions.history(id);
    const snapshot = history.snapshot();
    for (const { entry } of history.readRange(1, snapshot.endSeq, snapshot, ["message"])) {
      if (
        entry.type === "message" &&
        entry.message.role === "user" &&
        typeof entry.message.content === "string"
      )
        pending.delete(entry.message.inputId ?? entry.message.content);
      if (!pending.size) break;
    }
    const inbox = queued.filter((input) => pending.has(input.deliveryId ?? input.text));
    if (inbox.length) this.pending.set(id, inbox);
    if (inbox.length !== queued.length) this.save(id);
  }
  followUp(id: string): PluginInput[] {
    return (this.pending.get(id) ?? []).filter(
      (input) => !input.subagentNotification || input.backgroundNotification,
    );
  }
  forget(id: string): void {
    this.pending.delete(id);
  }
  private save(id: string) {
    this.ports.storage.setRuntime(
      id,
      "subagent_inbox",
      "inbox",
      (this.pending.get(id) ?? []).filter((input) => input.subagentNotification),
      "queued",
    );
  }

  offer(id: string, run: PluginRun, toolBoundary = false) {
    if (run.aborted || !run.session) return;
    const offered = this.offered.get(run) ?? new Set<PluginInput>();
    this.offered.set(run, offered);
    for (const input of this.pending.get(id) ?? []) {
      if (
        !offered.has(input) &&
        (!input.backgroundNotification || toolBoundary) &&
        run.session.steer(
          input.agentMessageKind
            ? formatAgentIncoming(
                input.text,
                input.agentMessageKind === "reply",
                input.receivedDuringRun === run.runId,
              )
            : input.text,
          {
            queueOnly: !!input.subagentNotification && !input.backgroundNotification,
            inputId: input.deliveryId,
          },
        )
      )
        offered.add(input);
    }
  }

  acknowledge(id: string, text: unknown, inputId?: string) {
    const inbox = this.pending.get(id);
    const index =
      inbox?.findIndex((input) => (inputId ? input.deliveryId === inputId : input.text === text)) ?? -1;
    if (!inbox || index < 0) return;
    inbox.splice(index, 1);
    if (!inbox.length) this.pending.delete(id);
    this.save(id);
  }

  async deliver(
    task: Pick<
      SubagentTask,
      "parentSessionId" | "agentId" | "agentType" | "description" | "status" | "result" | "error"
    > &
      Partial<SubagentTask>,
    reply?: { summary: string; message: string },
    backgroundNotification = false,
  ) {
    const parentId = task.parentSessionId;
    if (this.ports.sessions.closed(parentId)) throw new Error("busy: 父会话已关闭");
    const text = backgroundNotification
      ? `<task-notification>\nagentId: ${task.agentId}\nstatus: ${task.status}\nsummary: ${escapeXml(task.description)}\n${escapeXml(task.result ?? task.error ?? "No output.")}\n</task-notification>`
      : reply
        ? formatSubagentMessage({
            agentId: task.agentId,
            agentType: task.agentType,
            summary: reply.summary,
            message: reply.message,
          })
        : agentTaskNotification({
            ...task,
            parentToolCallId: task.parentToolCallId ?? task.agentId,
            childSessionId: task.childSessionId ?? "",
            color: task.color ?? "blue",
            background: task.background ?? true,
            startedAt: task.startedAt ?? Date.now(),
            totalToolUseCount: task.totalToolUseCount ?? 0,
            totalTokens: task.totalTokens ?? 0,
          } as SubagentTask);
    const input: PluginInput = {
      sessionId: parentId,
      deliveryId: randomUUID(),
      ...(backgroundNotification ? { backgroundNotification: true } : {}),
      text,
      ...(!backgroundNotification
        ? {
            agentMessageKind: reply ? ("reply" as const) : ("notification" as const),
            receivedDuringRun: this.ports.sessions.active(parentId)?.runId,
          }
        : {}),
      subagentNotification: {
        agentId: task.agentId,
        agentType: task.agentType,
        description: reply?.summary ?? task.description,
      },
    };
    const active = this.ports.sessions.active(parentId);
    if (backgroundNotification && !active) {
      await this.ports.sessions.run(input, !!this.isChild(parentId));
      return;
    }
    const inbox = this.pending.get(parentId) ?? [];
    inbox.push(input);
    this.pending.set(parentId, inbox);
    // Acceptance is durable and independent of starting a model turn.
    this.save(parentId);
    if (active) this.offer(parentId, active);
  }
}
