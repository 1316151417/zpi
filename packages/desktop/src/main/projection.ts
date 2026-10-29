import type { Message } from "zpi-ai";
import { isJsonObject } from "zpi-ai";
import type { AgentSessionEvent, Attachment, SessionEntry } from "zpi-coding-agent";
import { patchLineCounts, projectStreamedToolJournal } from "zpi-coding-agent";
import type { DesktopEvent, FileChangeSummary, RunStatus, SessionView, UserQuestionResponse } from "zpi-ui";
import { emptySession, normalizeWebToolDetails, reduceSession, resultText } from "zpi-ui/projection";

function questionAnswers(toolName: string, details: unknown): UserQuestionResponse | undefined {
  if (toolName !== "AskUserQuestion" || !isJsonObject(details) || !isJsonObject(details.answers)) return;
  return {
    answers: Object.fromEntries(
      Object.entries(details.answers)
        .filter(
          (entry): entry is [string, string] =>
            entry[0].length <= 8000 && typeof entry[1] === "string" && entry[1].length <= 16000,
        )
        .slice(0, 4),
    ),
  };
}

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
    ...(typeof change.patch === "string" && Buffer.byteLength(change.patch) <= 64 * 1024
      ? { patch: change.patch }
      : typeof change.patch === "string" || typeof change.patchFile === "string"
        ? { patchAvailable: true }
        : {}),
    ...counts,
    ...(typeof change.additions === "number" ? { additions: change.additions } : {}),
    ...(typeof change.deletions === "number" ? { deletions: change.deletions } : {}),
    ...(change.failed === true ? { failed: true } : {}),
    ...(typeof change.reason === "string" ? { reason: change.reason } : {}),
  };
}

export function projectEvent(event: AgentSessionEvent, messageId: string): DesktopEvent | undefined {
  if (event.type === "model_performance") return { type: event.type, performance: event.performance };
  if (event.type === "model_retry" || event.type === "model_wait") return event;
  if (event.type === "compaction") return event;
  if (event.type === "message_start") return { type: "message_start", messageId, role: event.message.role };
  if (event.type === "message_end")
    return { type: "message_end", messageId, message: visibleMessage(event.message), timestamp: Date.now() };
  if (event.type === "message_update") {
    const e = event.assistantMessageEvent;
    if (e.type === "reset") return { type: "message_reset", messageId };
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
      web: normalizeWebToolDetails(
        isJsonObject(event.partialResult.details) ? event.partialResult.details.web : undefined,
        event.toolName,
      ),
    };
  if (event.type === "tool_execution_end")
    return {
      type: "tool_end",
      toolCallId: event.toolCallId,
      output: resultText(event.result),
      isError: event.isError,
      hasFileChange: isJsonObject(event.result.details) && isJsonObject(event.result.details.fileChange),
      fileChange: fileChangeSummary(event.result.details),
      questionAnswers: questionAnswers(event.toolName, event.result.details),
      web: normalizeWebToolDetails(
        isJsonObject(event.result.details) ? event.result.details.web : undefined,
        event.toolName,
      ),
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
  for (const e of projectStreamedToolJournal(entries)) {
    if (
      e.type === "custom" &&
      e.customType === "zpi.compaction" &&
      isJsonObject(e.data) &&
      e.data.runId === runId &&
      typeof e.data.id === "string" &&
      ["running", "completed", "aborted", "error", "noop"].includes(String(e.data.status)) &&
      (e.data.origin === "manual" || e.data.origin === "auto")
    )
      apply({
        type: "compaction",
        id: e.data.id,
        status: e.data.status as "running" | "completed" | "aborted" | "error" | "noop",
        origin: e.data.origin,
        ...(typeof e.data.error === "string" ? { error: e.data.error } : {}),
      });
    if (
      e.type === "custom" &&
      e.customType === "zpi.notice" &&
      isJsonObject(e.data) &&
      typeof e.data.text === "string" &&
      e.data.runId === runId
    ) {
      if (/^(上下文已压缩|上下文接近容量|自动压缩失败)/.test(e.data.text)) {
        if (!view.runs.find((run) => run.runId === runId)?.compactions?.length)
          apply({
            type: "compaction",
            id: e.id,
            status: e.data.text.startsWith("自动压缩失败") ? "error" : "completed",
            origin: view.runs.find((run) => run.runId === runId)?.kind === "compact" ? "manual" : "auto",
          });
      } else apply({ type: "notice", text: e.data.text });
    }
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
        attachments?: Attachment[];
        ordinalStart?: number;
        historyContinuation?: boolean;
        subagentNotification?: import("zpi-ui").SubagentNotification;
      };
      if (d.phase === "start" && d.runId) {
        runId = d.runId;
        ordinal = d.ordinalStart ?? 0;
        apply({
          type: "started",
          historyContinuation: d.historyContinuation,
          text: d.text ?? "",
          subagentNotification: d.subagentNotification,
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
      apply({
        type: "message_end",
        messageId: `${runId}:${ordinal}`,
        message: visibleMessage(mergeLegacyReasoningSummaries(e.message)),
      });
    }
  }
  for (const r of view.runs.filter((r) => r.status === "running")) {
    runId = r.runId;
    apply({ type: "settled", status: "interrupted", endedAt: Date.now() });
  }
  return { ...view, seq: 0 };
}

function mergeLegacyReasoningSummaries(message: Message): Message {
  if (message.role !== "assistant" || message.api !== "openai-responses") return message;
  const content: typeof message.content = [];
  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index];
    content.push(block);
    if (block.type !== "thinking" || !block.thinkingSignature) continue;
    try {
      const item: unknown = JSON.parse(block.thinkingSignature);
      if (!isJsonObject(item) || item.type !== "reasoning" || !Array.isArray(item.summary)) continue;
      const parts = item.summary;
      // Older adapters stored each summary separately, with the item signature only on the first.
      if (
        parts.length < 2 ||
        !parts.every((part, offset) => {
          const next = message.content[index + offset];
          return (
            isJsonObject(part) &&
            part.type === "summary_text" &&
            typeof part.text === "string" &&
            next?.type === "thinking" &&
            (offset === 0 || !next.thinkingSignature) &&
            next.thinking === part.text
          );
        })
      )
        continue;
      content[content.length - 1] = {
        ...block,
        thinking: parts
          .map((part) => part.text)
          .filter(Boolean)
          .join("\n\n"),
      };
      index += parts.length - 1;
    } catch {
      // Malformed historical signatures must not prevent the conversation from opening.
    }
  }
  return { ...message, content };
}

function visibleMessage(message: Message): Message {
  if (message.role === "user") return { role: "user", content: "", timestamp: message.timestamp };
  if (message.role === "system") return { role: "system", content: "", timestamp: message.timestamp };
  if (message.role === "toolResult") {
    const fileChange = fileChangeSummary(message.details);
    const answers = questionAnswers(message.toolName, message.details);
    const web = normalizeWebToolDetails(
      isJsonObject(message.details) ? message.details.web : undefined,
      message.toolName,
    );
    return {
      ...message,
      details: {
        hasFileChange: isJsonObject(message.details) && isJsonObject(message.details.fileChange),
        ...(fileChange ? { fileChange: { ...fileChange } } : {}),
        ...(answers ? { questionAnswers: { answers: answers.answers } } : {}),
        ...(web ? { web: JSON.parse(JSON.stringify(web)) } : {}),
      },
      content: message.content.map((c) =>
        c.type === "image" ? { type: "text", text: "[Image result]" } : c,
      ),
    };
  }
  return message;
}
