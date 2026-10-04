import type { Message } from "zpi-ai";
import { isJsonObject } from "zpi-ai";
import type { AgentSessionEvent, ImageAttachment, SessionEntry } from "zpi-coding-agent";
import { patchLineCounts } from "zpi-coding-agent";
import type { DesktopEvent, FileChangeSummary, RunStatus, SessionView } from "zpi-ui";
import { emptySession, reduceSession, resultText } from "zpi-ui/projection";

function fileChangeSummary(details: unknown): FileChangeSummary | undefined {
  if (
    !isJsonObject(details) ||
    !isJsonObject(details.fileChange) ||
    typeof details.fileChange.path !== "string"
  )
    return;
  const change = details.fileChange;
  let counts: { additions: number; deletions: number } | undefined;
  if (typeof change.patch === "string") {
    try {
      counts = patchLineCounts(change.patch);
    } catch {
      /* Historical malformed patches remain viewable as unknown counts. */
    }
  }
  return {
    path: change.path as string,
    ...counts,
    ...(typeof change.additions === "number" ? { additions: change.additions } : {}),
    ...(typeof change.deletions === "number" ? { deletions: change.deletions } : {}),
    ...(change.failed === true ? { failed: true } : {}),
    ...(typeof change.reason === "string" ? { reason: change.reason } : {}),
  };
}

export function projectEvent(event: AgentSessionEvent, messageId: string): DesktopEvent | undefined {
  if (event.type === "command_result") return { type: "notice", text: event.message };
  if (event.type === "message_start") return { type: "message_start", messageId, role: event.message.role };
  if (event.type === "message_end")
    return { type: "message_end", messageId, message: visibleMessage(event.message), timestamp: Date.now() };
  if (event.type === "message_update") {
    const e = event.assistantMessageEvent;
    if (e.type === "text_start" || e.type === "thinking_start" || e.type === "toolcall_start")
      return {
        type: "block_start",
        timestamp: Date.now(),
        messageId,
        contentIndex: e.contentIndex,
        kind: e.type === "text_start" ? "text" : e.type === "thinking_start" ? "thinking" : "tool",
        ...(e.type === "toolcall_start"
          ? {
              toolCall: e.partial.content[e.contentIndex] as Extract<
                Message,
                { role: "assistant" }
              >["content"][number] & { type: "toolCall" },
            }
          : {}),
      };
    if (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "toolcall_delta")
      return { type: "block_delta", messageId, contentIndex: e.contentIndex, delta: e.delta };
    if (e.type === "toolcall_end")
      return { type: "tool_ready", messageId, contentIndex: e.contentIndex, toolCall: e.toolCall };
    if (e.type === "thinking_end" || e.type === "text_end")
      return { type: "block_end", messageId, contentIndex: e.contentIndex, timestamp: Date.now() };
  }
  if (event.type === "tool_execution_start")
    return {
      type: "tool_start",
      toolCallId: event.toolCallId,
      name: event.toolName,
      argsText: JSON.stringify(event.args, null, 2),
    };
  if (event.type === "tool_execution_update")
    return {
      type: "tool_update",
      toolCallId: event.toolCallId,
      output: resultText(event.partialResult),
    };
  if (event.type === "tool_execution_end")
    return {
      type: "tool_end",
      toolCallId: event.toolCallId,
      output: resultText(event.result),
      isError: event.isError,
      hasFileChange: isJsonObject(event.result.details) && isJsonObject(event.result.details.fileChange),
      fileChange: fileChangeSummary(event.result.details),
    };
  return undefined;
}
export function restoreView(sessionId: string, title: string, entries: SessionEntry[]): SessionView {
  let view = emptySession(sessionId, title);
  let runId = "";
  let ordinal = 0;
  let seq = 0;
  const apply = (event: DesktopEvent) => {
    view = reduceSession(view, { sessionId, runId, seq: ++seq, event });
  };
  for (const e of entries) {
    if (
      e.type === "custom" &&
      e.customType === "zpi.notice" &&
      isJsonObject(e.data) &&
      typeof e.data.text === "string" &&
      e.data.runId === runId
    )
      apply({ type: "notice", text: e.data.text });
    if (
      e.type === "custom" &&
      e.customType === "zpi.run" &&
      e.data &&
      typeof e.data === "object" &&
      !Array.isArray(e.data)
    ) {
      const d = e.data as {
        phase?: string;
        runId?: string;
        text?: string;
        startedAt?: number;
        endedAt?: number;
        status?: RunStatus;
        error?: string;
        modelLabel?: string;
        fileReferences?: string[];
        attachments?: ImageAttachment[];
        ordinalStart?: number;
      };
      if (d.phase === "start" && d.runId) {
        runId = d.runId;
        ordinal = d.ordinalStart ?? 0;
        apply({
          type: "started",
          text: d.text ?? "",
          fileReferences: d.fileReferences ?? [],
          attachments: d.attachments ?? [],
          startedAt: d.startedAt ?? Date.parse(e.timestamp),
          modelLabel: d.modelLabel ?? "",
        });
      }
      if (d.phase === "end" && d.runId) {
        runId = d.runId;
        apply({
          type: "settled",
          status: d.status && d.status !== "running" ? d.status : "interrupted",
          endedAt: d.endedAt ?? Date.parse(e.timestamp),
          error: d.error,
        });
      }
    }
    if (e.type === "message" && e.message.role !== "system" && runId) {
      ordinal++;
      apply({ type: "message_end", messageId: `${runId}:${ordinal}`, message: visibleMessage(e.message) });
    }
  }
  for (const r of view.runs.filter((r) => r.status === "running")) {
    runId = r.runId;
    apply({ type: "settled", status: "interrupted", endedAt: Date.now() });
  }
  return { ...view, seq: 0 };
}

function visibleMessage(message: Message): Message {
  if (message.role === "user") return { role: "user", content: "", timestamp: message.timestamp };
  if (message.role === "system") return { role: "system", content: "", timestamp: message.timestamp };
  if (message.role === "toolResult") {
    const fileChange = fileChangeSummary(message.details);
    return {
      ...message,
      details: {
        hasFileChange: isJsonObject(message.details) && isJsonObject(message.details.fileChange),
        ...(fileChange ? { fileChange: { ...fileChange } } : {}),
      },
      content: message.content.map((c) =>
        c.type === "image" ? { type: "text", text: "[Image result]" } : c,
      ),
    };
  }
  return message;
}
