import { workDuration } from "./components/process-presentation.ts";
import { cancelledWebTool, normalizeWebToolDetails } from "./components/web-tool-data.ts";
import type { DesktopEventEnvelope, RunView, SessionView, ViewBlock } from "./types.ts";
import { resultText } from "./types.ts";
export function emptySession(sessionId: string, title = "新对话"): SessionView {
  return { sessionId, title, seq: 0, runs: [] };
}
/** Approximate retained UTF-16 text; use the same measure when adding and evicting views. */
export function sessionViewBytes(view: SessionView): number {
  let chars = view.title.length;
  for (const run of view.runs) {
    chars +=
      run.userMessage.length +
      (run.error?.length ?? 0) +
      (run.notice?.length ?? 0) +
      (run.preparation?.length ?? 0);
    for (const marker of run.compactions ?? [])
      chars += marker.id.length + (marker.afterBlockId?.length ?? 0) + (marker.error?.length ?? 0);
    for (const block of run.orderedBlocks) {
      chars += block.type === "tool" ? block.output.length + block.argsText.length : block.text.length;
      if (block.type === "tool" && block.questionAnswers)
        for (const [question, answer] of Object.entries(block.questionAnswers.answers))
          chars += question.length + answer.length;
      if (block.type === "tool" && block.web) chars += JSON.stringify(block.web).length;
    }
  }
  for (const item of view.queue?.items ?? []) chars += item.text.length;
  for (const task of view.backgroundTasks ?? [])
    chars += task.taskId.length + task.command.length + task.description.length + task.outputPath.length;
  for (const task of view.subagents ?? [])
    chars +=
      task.agentId.length +
      task.agentType.length +
      task.description.length +
      task.modelLabel.length +
      (task.result?.length ?? 0) +
      (task.error?.length ?? 0) +
      (task.latestActivity?.length ?? 0);
  return chars * 2;
}
/** Pure projection: update only the addressed run. Completed messages replace deltas. */
export function reduceSession(view: SessionView, envelope: DesktopEventEnvelope): SessionView {
  if (envelope.sessionId !== view.sessionId || envelope.seq <= view.seq) return view;
  const { event, runId, seq } = envelope;
  if (event.type === "model_performance") {
    if (view.runs.at(-1)?.runId !== runId) return { ...view, seq };
    return { ...view, seq, modelPerformance: event.performance };
  }
  if (event.type === "background_task_changed") {
    const tasks = view.backgroundTasks ?? [];
    const index = tasks.findIndex((task) => task.taskId === event.task.taskId);
    const backgroundTasks = [...tasks];
    if (index < 0) backgroundTasks.push(event.task);
    else backgroundTasks[index] = event.task;
    return { ...view, seq, backgroundTasks };
  }
  if (event.type === "subagent_changed") {
    const tasks = view.subagents ?? [];
    const index = tasks.findIndex((task) => task.agentId === event.task.agentId);
    const subagents = [...tasks];
    if (index < 0) subagents.push(event.task);
    else subagents[index] = event.task;
    return { ...view, seq, subagents };
  }
  if (event.type === "history_reset") return { ...normalizeWebHistory(event.view), seq };
  if (event.type === "session_changed") return { ...view, seq, title: event.title };
  if (event.type === "controls_changed") return { ...view, seq, controls: event.controls };
  if (event.type === "queue_changed") return { ...view, seq, queue: event.queue };
  if (event.type === "question_changed") return { ...view, seq, question: event.question };
  if (event.type === "environment_changed") return { ...view, seq };
  let index = view.runs.findIndex((r) => r.runId === runId);
  if (index < 0 && event.type !== "started") return { ...view, seq };
  const runs = [...view.runs];
  if (index < 0) {
    index = runs.length;
    runs.push({
      runId,
      status: "running",
      userMessage: "",
      orderedBlocks: [],
      finalAnswerBlockIds: [],
      startedAt: Date.now(),
    });
  }
  const run: RunView = {
    ...runs[index],
    orderedBlocks: [...runs[index].orderedBlocks],
    finalAnswerBlockIds: [...runs[index].finalAnswerBlockIds],
  };
  runs[index] = run;
  const blockId = (messageId: string, n: number) => `${messageId}:${n}`;
  const replace = (id: string, block: ViewBlock) => {
    const i = run.orderedBlocks.findIndex((b) => b.id === id);
    if (i < 0) run.orderedBlocks.push(block);
    else run.orderedBlocks[i] = block;
  };
  const tool = (id: string) => run.orderedBlocks.find((b) => b.type === "tool" && b.toolCallId === id);
  const interruptFailedMessage = () => {
    if (!run.failedMessageId) return;
    const messageId = run.failedMessageId;
    run.orderedBlocks = run.orderedBlocks.map((block) =>
      block.messageId === messageId && block.type !== "tool"
        ? { ...block, streaming: false, interrupted: true }
        : block,
    );
    run.finalAnswerBlockIds = run.finalAnswerBlockIds.filter(
      (id) => !run.orderedBlocks.some((block) => block.id === id && block.messageId === messageId),
    );
  };
  if (event.type === "started") {
    run.historyContinuation = event.historyContinuation;
    run.userMessage = event.text;
    run.subagentNotification = event.subagentNotification;
    run.fileReferences = event.fileReferences ?? [];
    run.attachments = event.attachments ?? [];
    run.startedAt = event.startedAt;
    run.modelLabel = event.modelLabel;
    if (/^\/compact(?:\s|$)/.test(event.text.trimStart())) run.kind = "compact";
  } else if (event.type === "run_preparation") {
    run.preparation = event.message;
  } else if (event.type === "compaction") {
    const markers = [...(run.compactions ?? [])];
    const index = markers.findIndex((marker) => marker.id === event.id);
    const marker = {
      id: event.id,
      status: event.status,
      origin: event.origin,
      error: event.error,
      afterBlockId: index < 0 ? run.orderedBlocks.at(-1)?.id : markers[index].afterBlockId,
    };
    if (index < 0) markers.push(marker);
    else markers[index] = marker;
    run.compactions = markers;
  } else if (event.type === "notice") {
    run.notice = event.text;
  } else if (event.type === "model_wait") {
    run.modelWait = run.status === "running" ? event.status : null;
  } else if (event.type === "model_retry") {
    run.apiRetry = run.status === "running" ? event.status : null;
    if (run.apiRetry) {
      interruptFailedMessage();
      run.error = undefined;
    }
  } else if (event.type === "message_start" && event.role === "assistant") {
    interruptFailedMessage();
    run.failedMessageId = undefined;
  } else if (event.type === "message_reset") {
    const removed = new Set(
      run.orderedBlocks.filter((b) => b.messageId === event.messageId).map((b) => b.id),
    );
    run.orderedBlocks = run.orderedBlocks.filter((b) => !removed.has(b.id));
    run.finalAnswerBlockIds = run.finalAnswerBlockIds.filter((id) => !removed.has(id));
  } else if (event.type === "block_end") {
    const id = blockId(event.messageId, event.contentIndex);
    const block = run.orderedBlocks.find((b) => b.id === id);
    if (block && block.type !== "tool")
      replace(id, {
        ...block,
        streaming: false,
        ...(block.startedAt !== undefined ? { endedAt: event.timestamp } : {}),
      });
  } else if (event.type === "settled") {
    // Stopping in the retry delay has no replacement message in the transcript.
    // Keep the last partial answer visible, matching a subsequent history restore.
    if (
      run.failedMessageId &&
      run.orderedBlocks.some(
        (block) => block.messageId === run.failedMessageId && block.type !== "tool" && block.interrupted,
      )
    ) {
      const failedBlocks = run.orderedBlocks.filter(
        (block) => block.messageId === run.failedMessageId && block.type !== "tool",
      );
      run.orderedBlocks = run.orderedBlocks.map((block) =>
        failedBlocks.includes(block) ? { ...block, interrupted: undefined } : block,
      );
      run.finalAnswerBlockIds = run.orderedBlocks.some(
        (block) => block.messageId === run.failedMessageId && block.type === "tool",
      )
        ? []
        : failedBlocks.filter((block) => block.type === "text").map((block) => block.id);
    }
    run.failedMessageId = undefined;
    run.preparation = null;
    run.apiRetry = null;
    run.modelWait = null;
    run.status = event.status;
    run.endedAt = event.endedAt;
    run.error = event.error;
    run.compactions = run.compactions?.map((marker) =>
      marker.status === "running"
        ? { ...marker, status: event.status === "completed" ? "interrupted" : event.status }
        : marker,
    );
    run.orderedBlocks = run.orderedBlocks.map((block) =>
      block.type !== "tool" && block.streaming
        ? { ...block, streaming: false, ...(block.startedAt !== undefined ? { endedAt: event.endedAt } : {}) }
        : block,
    );
    run.orderedBlocks = run.orderedBlocks.map((block) =>
      block.type === "tool" &&
      (block.name === "web_search" || block.name === "web_fetch") &&
      (block.web?.status === "pending" || block.status === "preparing" || block.status === "running")
        ? {
            ...block,
            status: "error",
            isError: true,
            web: {
              ...block.web,
              kind: block.name,
              status: ["aborted", "interrupted"].includes(event.status) ? "cancelled" : "error",
              message: "联网工具已停止，未收到结果。",
            },
          }
        : block,
    );
    if (event.status === "interrupted")
      run.orderedBlocks = run.orderedBlocks.map((b) =>
        b.type === "tool" && (b.status === "preparing" || b.status === "running")
          ? {
              ...b,
              status: "error",
              isError: true,
              output: `${b.output}\nInterrupted: side effects unknown; tool was not replayed.`,
            }
          : b,
      );
  } else if (event.type === "block_start") {
    const id = blockId(event.messageId, event.contentIndex);
    if (event.kind === "tool") {
      run.finalAnswerBlockIds = [];
      replace(id, {
        id,
        messageId: event.messageId,
        type: "tool",
        toolCallId: event.toolCall?.id ?? "",
        name: event.toolCall?.name ?? "",
        argsText: "",
        status: "preparing",
        output: "",
      });
    } else {
      replace(id, {
        id,
        messageId: event.messageId,
        type: event.kind,
        text: "",
        streaming: true,
        ...(event.timestamp !== undefined ? { startedAt: event.timestamp } : {}),
      });
      if (event.kind === "text") run.finalAnswerBlockIds.push(id);
    }
  } else if (event.type === "block_delta") {
    const id = blockId(event.messageId, event.contentIndex);
    const b = run.orderedBlocks.find((b) => b.id === id);
    if (b)
      replace(
        id,
        b.type === "tool"
          ? { ...b, argsText: b.argsText + event.delta }
          : { ...b, text: b.text + event.delta },
      );
  } else if (event.type === "tool_ready") {
    const id = blockId(event.messageId, event.contentIndex);
    const b = run.orderedBlocks.find((b) => b.id === id);
    if (b?.type === "tool")
      replace(id, {
        ...b,
        name: event.toolCall.name,
        toolCallId: event.toolCall.id,
        argsText: JSON.stringify(event.toolCall.arguments, null, 2),
      });
    run.finalAnswerBlockIds = [];
  } else if (event.type === "tool_start") {
    const b = tool(event.toolCallId);
    if (b?.type === "tool")
      replace(b.id, { ...b, name: event.name, argsText: event.argsText, status: "running" });
    run.finalAnswerBlockIds = [];
  } else if (event.type === "tool_update" || event.type === "tool_end") {
    const b = tool(event.toolCallId);
    if (b?.type === "tool")
      replace(b.id, {
        ...b,
        output: event.output,
        web:
          event.web === undefined
            ? (cancelledWebTool(b.name, event.output, event.isError) ?? b.web)
            : normalizeWebToolDetails(event.web, b.name),
        ...(event.type === "tool_end"
          ? {
              isError: event.isError,
              hasFileChange: event.hasFileChange,
              fileChange: event.fileChange,
              questionAnswers: event.questionAnswers,
              status: event.isError ? "error" : "completed",
            }
          : {}),
      });
  } else if (event.type === "message_end") {
    const m = event.message;
    if (m.role === "assistant") {
      // History has message facts rather than live retry events. Close the failed
      // attempt before projecting its replacement, just as the live retry does.
      if (run.failedMessageId !== event.messageId) interruptFailedMessage();
      const oldBlocks = new Map(run.orderedBlocks.map((block) => [block.id, block]));
      const oldTools = new Map(
        run.orderedBlocks.filter((b) => b.type === "tool").map((b) => [b.toolCallId, b]),
      );
      run.orderedBlocks = run.orderedBlocks.filter((b) => b.messageId !== event.messageId);
      const finalIds: string[] = [];
      let hasTools = false;
      for (const [n, c] of m.content.entries()) {
        const id = blockId(event.messageId, n);
        if (c.type === "toolCall") {
          hasTools = true;
          const previous = oldTools.get(c.id) ?? tool(c.id);
          replace(id, {
            id,
            messageId: event.messageId,
            type: "tool",
            toolCallId: c.id,
            name: c.name,
            argsText: JSON.stringify(c.arguments, null, 2),
            status: previous?.type === "tool" ? previous.status : "preparing",
            output: previous?.type === "tool" ? previous.output : "",
            isError: previous?.type === "tool" ? previous.isError : undefined,
            hasFileChange: previous?.type === "tool" ? previous.hasFileChange : undefined,
            fileChange: previous?.type === "tool" ? previous.fileChange : undefined,
            questionAnswers: previous?.type === "tool" ? previous.questionAnswers : undefined,
            web: previous?.type === "tool" ? previous.web : undefined,
          });
        } else {
          const previous = oldBlocks.get(id);
          replace(id, {
            id,
            messageId: event.messageId,
            type: c.type,
            ...(previous?.type === "thinking" && previous.startedAt !== undefined
              ? { startedAt: previous.startedAt, endedAt: previous.endedAt ?? event.timestamp }
              : c.type === "text"
                ? { startedAt: m.timestamp }
                : {}),
            text: c.type === "text" ? c.text : c.thinking,
            streaming: false,
          });
          if (c.type === "text") finalIds.push(id);
        }
      }
      run.finalAnswerBlockIds = hasTools ? [] : finalIds;
      run.error = m.errorMessage;
      run.failedMessageId = m.stopReason === "error" ? event.messageId : undefined;
    }
    if (m.role === "toolResult") {
      const b = tool(m.toolCallId);
      if (b?.type === "tool")
        replace(b.id, {
          ...b,
          output: resultText(m),
          hasFileChange: Boolean(
            m.details &&
              typeof m.details === "object" &&
              "hasFileChange" in m.details &&
              m.details.hasFileChange === true,
          ),
          isError: m.isError,
          fileChange:
            m.details && typeof m.details === "object" && "fileChange" in m.details
              ? (m.details.fileChange as unknown as import("./types.ts").FileChangeSummary)
              : b.fileChange,
          status: m.isError ? "error" : "completed",
          questionAnswers:
            m.details && typeof m.details === "object" && "questionAnswers" in m.details
              ? (m.details.questionAnswers as unknown as import("./types.ts").UserQuestionResponse)
              : b.questionAnswers,
          web:
            m.details && typeof m.details === "object" && "web" in m.details
              ? normalizeWebToolDetails(m.details.web, b.name)
              : (cancelledWebTool(b.name, resultText(m), m.isError) ?? b.web),
        });
    }
  }
  return { ...view, seq, runs };
}
export function progressSummary(run: RunView, now = Date.now()): string {
  const status = {
    running: "工作中",
    completed: "已工作",
    aborted: "已停止",
    error: "运行失败",
    interrupted: "已中断",
  }[run.status];
  return `${status} ${workDuration((run.endedAt ?? (run.status === "running" ? now : run.startedAt)) - run.startedAt)}`;
}

export { normalizeWebToolDetails } from "./components/web-tool-data.ts";
export { resultText } from "./types.ts";

function normalizeWebHistory(view: SessionView): SessionView {
  return {
    ...view,
    runs: view.runs.map((run) =>
      run.orderedBlocks.some((block) => block.type === "tool" && block.web !== undefined)
        ? {
            ...run,
            orderedBlocks: run.orderedBlocks.map((block) =>
              block.type === "tool" && block.web !== undefined
                ? { ...block, web: normalizeWebToolDetails(block.web, block.name) }
                : block,
            ),
          }
        : run,
    ),
  };
}

export function mergeHistory(older: SessionView, newer: SessionView): SessionView {
  const runs = [...older.runs];
  const indices = new Map<string, number>();
  for (const [index, run] of runs.entries()) {
    if (!indices.has(run.runId)) indices.set(run.runId, index);
  }
  for (const run of newer.runs) {
    const index = indices.get(run.runId);
    if (index === undefined) {
      indices.set(run.runId, runs.length);
      runs.push(run);
    } else {
      const blocks = new Map(runs[index].orderedBlocks.map((b) => [b.id, b]));
      for (const block of run.orderedBlocks) blocks.set(block.id, block);
      const compactions = new Map(runs[index].compactions?.map((marker) => [marker.id, marker]));
      for (const marker of run.compactions ?? []) compactions.set(marker.id, marker);
      const input = run.historyContinuation && !runs[index].historyContinuation ? runs[index] : run;
      runs[index] = {
        ...run,
        historyContinuation: input.historyContinuation,
        userMessage: input.userMessage,
        fileReferences: input.fileReferences,
        attachments: input.attachments,
        subagentNotification: input.subagentNotification,
        kind: input.kind,
        orderedBlocks: [...blocks.values()],
        compactions: [...compactions.values()],
      };
    }
  }
  return normalizeWebHistory({ ...newer, runs });
}
