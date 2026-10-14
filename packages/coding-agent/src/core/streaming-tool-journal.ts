import { randomUUID } from "node:crypto";
import type { AgentEvent } from "zpi-agent";
import type { AssistantMessage, JsonValue, Message, ToolResultMessage } from "zpi-ai";
import { isJsonObject } from "zpi-ai";
import { validateMessage } from "./record-validation.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

const JOURNAL_TYPE = "zpi.streaming_tools";
interface Journal {
  id: string;
  anchorId: string | null;
  assistant: AssistantMessage;
  results: ToolResultMessage[];
}

/** Calls are durable before execute; results are durable before the batch settles. */
export class StreamingToolJournal {
  private partial?: AssistantMessage;
  private journal?: Journal;
  private manager: SessionManager;
  private notify: () => void;
  constructor(manager: SessionManager, notify: () => void) {
    this.manager = manager;
    this.notify = notify;
  }
  private save(data: unknown) {
    this.manager.appendCustomEntry(JOURNAL_TYPE, JSON.parse(JSON.stringify(data)) as JsonValue);
    this.notify();
  }
  observe(event: AgentEvent) {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.partial = event.message;
      this.journal = {
        id: randomUUID(),
        anchorId: this.manager.getLastEntry()?.id ?? null,
        assistant: { ...structuredClone(event.message), content: [], stopReason: "toolUse" },
        results: [],
      };
    }
    if (event.type === "message_update" && event.message.role === "assistant") this.partial = event.message;
    const journal = this.journal;
    if (!journal) return;
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.partial = event.message;
      const calls = event.message.content.filter((c) => c.type === "toolCall");
      if (calls.length) {
        // The final declaration includes deferred calls and restores their order
        // when a later read has already run during streaming. Persist it before
        // the canonical assistant, including calls not yet prepared/executed.
        journal.assistant = structuredClone({ ...event.message, content: calls });
        this.save({ ...journal, results: [], responseComplete: true });
      }
    }
    if (event.type === "tool_execution_start") {
      const call = this.partial?.content.find((c) => c.type === "toolCall" && c.id === event.toolCallId);
      if (call?.type !== "toolCall") throw new Error("Missing closed tool call");
      if (!journal.assistant.content.some((c) => c.type === "toolCall" && c.id === call.id)) {
        journal.assistant.content.push(structuredClone(call));
        this.save({ ...journal, assistant: { ...journal.assistant, content: [call] }, results: [] });
      }
    }
    if (
      event.type === "tool_execution_end" &&
      journal.assistant.content.some((c) => c.type === "toolCall" && c.id === event.toolCallId)
    ) {
      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        content: event.result.content,
        details: event.result.details,
        isError: event.isError,
        timestamp: Date.now(),
      };
      const call = journal.assistant.content.find((c) => c.type === "toolCall" && c.id === event.toolCallId);
      this.save({ ...journal, assistant: { ...journal.assistant, content: [call] }, results: [result] });
    }
    if (event.type === "turn_end") {
      if (journal.assistant.content.length) this.save({ id: journal.id, committed: true });
      this.journal = undefined;
      this.partial = undefined;
    }
  }
}

/** Missing canonical messages after a crash; never rerun a pending tool. */
function interruptedMessages(entries: SessionEntry[]): { index: number; id: string; messages: Message[] }[] {
  // Read only unresolved journals. Completed calls do not add validation or
  // cloning work to every history load. Completion records carry only one call;
  // the response checkpoint carries the full declaration once, in model order.
  const records = new Map<string, { index: number; data: JsonValue }[]>();
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "custom" || entry.customType !== JOURNAL_TYPE || !isJsonObject(entry.data)) continue;
    const data = entry.data;
    if (typeof data.id !== "string") throw new Error("Invalid streaming tool journal");
    if (data.committed === true) {
      records.delete(data.id);
      continue;
    }
    const updates = records.get(data.id) ?? [];
    updates.push({ index, data });
    records.set(data.id, updates);
  }
  const pending = new Map<string, { index: number; journal: Journal }>();
  for (const [id, updates] of records) {
    for (const { index, data } of updates) {
      if (!isJsonObject(data)) throw new Error("Invalid streaming tool journal");
      validateMessage(data.assistant);
      if (
        !isJsonObject(data.assistant) ||
        data.assistant.role !== "assistant" ||
        !(data.anchorId === null || typeof data.anchorId === "string") ||
        !Array.isArray(data.results)
      )
        throw new Error("Invalid streaming tool journal");
      for (const result of data.results) {
        validateMessage(result);
        if (!isJsonObject(result) || result.role !== "toolResult")
          throw new Error("Invalid streamed tool result");
      }
      const update = data as unknown as Journal;
      let previous = pending.get(id);
      if (!previous) {
        previous = {
          index,
          journal: { ...update, assistant: { ...update.assistant, content: [] }, results: [] },
        };
        pending.set(id, previous);
      }
      if (data.responseComplete === true) previous.journal.assistant = { ...update.assistant, content: [] };
      for (const call of update.assistant.content) {
        if (call.type !== "toolCall") throw new Error("Invalid streaming tool call");
        if (!previous.journal.assistant.content.some((c) => c.type === "toolCall" && c.id === call.id))
          previous.journal.assistant.content.push(call);
      }
      for (const result of update.results) {
        previous.journal.results = previous.journal.results.filter((r) => r.toolCallId !== result.toolCallId);
        previous.journal.results.push(result);
      }
      previous.index = index;
    }
  }
  return [...pending.values()].map(({ index, journal }) => {
    const anchor = entries.findIndex((entry) => entry.id === journal.anchorId);
    let calls = journal.assistant.content.filter((c) => c.type === "toolCall");
    const canonical = entries.findIndex(
      (entry, i) =>
        i > anchor &&
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        calls.some(
          (call) =>
            entry.message.role === "assistant" &&
            entry.message.content.some((c) => c.type === "toolCall" && c.id === call.id),
        ),
    );
    const declaration = entries[canonical];
    if (declaration?.type === "message" && declaration.message.role === "assistant")
      calls = declaration.message.content.filter((c) => c.type === "toolCall");
    const paired = new Set<string>();
    let insertion = Math.max(index, canonical);
    for (let i = Math.max(anchor, canonical) + 1; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant") break;
      if (message.role === "toolResult" && calls.some((call) => call.id === message.toolCallId)) {
        paired.add(message.toolCallId);
        insertion = Math.max(insertion, i);
      }
    }
    const messages: Message[] = canonical < 0 ? [journal.assistant] : [];
    for (const call of calls) {
      if (paired.has(call.id)) continue;
      messages.push(
        journal.results.find((r) => r.toolCallId === call.id) ?? {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          isError: true,
          content: [
            {
              type: "text",
              text: "Tool execution was interrupted before a result was committed. Side effects may be unknown; inspect current state before retrying.",
            },
          ],
          details: { type: "stream_recovery_interrupted_tool", reason: "unknown_execution_state" },
          timestamp: Date.now(),
        },
      );
    }
    return { index: insertion, id: journal.id, messages };
  });
}

export function recoverStreamedToolJournal(manager: SessionManager): void {
  for (const { id, messages } of interruptedMessages(manager.getEntries())) {
    for (const message of messages) manager.appendMessage(message);
    manager.appendCustomEntry(JOURNAL_TYPE, { id, committed: true });
  }
}

/** History rendering also works before the writable SDK session is opened. */
export function projectStreamedToolJournal(entries: SessionEntry[]): SessionEntry[] {
  const additions = interruptedMessages(entries);
  return entries.flatMap((entry, index) => [
    entry,
    ...additions
      .filter((addition) => addition.index === index)
      .flatMap(({ id, messages }) =>
        messages.map(
          (message, n): SessionEntry => ({
            type: "message",
            id: `${id}:${n}`,
            parentId: entry.id,
            timestamp: entry.timestamp,
            message,
          }),
        ),
      ),
  ]);
}
