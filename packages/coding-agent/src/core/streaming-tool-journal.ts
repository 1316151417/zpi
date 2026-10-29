import { randomUUID } from "node:crypto";
import type { AgentEvent } from "zpi-agent";
import type { AssistantMessage, JsonValue, Message, ToolCall, ToolResultMessage } from "zpi-ai";
import { isJsonObject } from "zpi-ai";
import { validateMessage } from "./record-validation.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";
import { getMessageProvenance } from "./transcript-store.ts";

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
  private async save(data: unknown) {
    await this.manager.appendEntryAsync({
      type: "custom",
      customType: JOURNAL_TYPE,
      data: JSON.parse(JSON.stringify(data)) as JsonValue,
    });
    this.notify();
  }
  async observe(event: AgentEvent) {
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
        await this.save({ ...journal, results: [], responseComplete: true });
      }
    }
    if (event.type === "tool_execution_start") {
      let call =
        event.toolCall ??
        this.partial?.content.find((c) => c.type === "toolCall" && c.id === event.toolCallId);
      // Terminal-only declarations can be interrupted before message_end updates
      // the partial. Legacy/manual events may only carry the closed call's input.
      if (!call && isJsonObject(event.args))
        call = { type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.args };
      if (call?.type !== "toolCall") throw new Error("Missing closed tool call");
      if (!journal.assistant.content.some((c) => c.type === "toolCall" && c.id === call.id)) {
        journal.assistant.content.push(structuredClone(call));
        await this.save({ ...journal, assistant: { ...journal.assistant, content: [call] }, results: [] });
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
      await this.save({
        ...journal,
        assistant: { ...journal.assistant, content: [call] },
        results: [result],
      });
    }
    if (event.type === "turn_end") {
      if (journal.assistant.content.length) await this.save({ id: journal.id, committed: true });
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
  for (const entries of manager.unresolvedToolJournals()) {
    for (const { id, messages } of interruptedMessages(entries)) {
      for (const message of messages) manager.appendMessage(message);
      manager.appendCustomEntry(JOURNAL_TYPE, { id, committed: true });
    }
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

/** Repair legacy canonical gaps within their declaring turn, without rerunning tools. */
function canonicalRepairPlan(
  manager: SessionManager,
  messages: Message[],
): { entries?: Iterable<SessionEntry>; trailing: Message[] } {
  const pending = new Map<string, ToolCall>();
  const insertions = new Map<string, ToolResultMessage[]>();
  const interrupted = (): ToolResultMessage[] => {
    const results = [...pending.values()].map(
      (call): ToolResultMessage => ({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          {
            type: "text",
            text: "Interrupted: prior execution outcome and side effects are unknown. This tool was not re-executed.",
          },
        ],
        isError: true,
        timestamp: Date.now(),
      }),
    );
    pending.clear();
    return results;
  };
  for (const message of messages) {
    if ((message.role === "assistant" || message.role === "user") && pending.size) {
      const anchor = getMessageProvenance(message)?.entryId;
      if (!anchor) throw new Error("Missing canonical message provenance");
      insertions.set(anchor, interrupted());
    }
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall" && !pending.has(part.id)) pending.set(part.id, part);
      }
    } else if (message.role === "toolResult") pending.delete(message.toolCallId);
  }
  if (insertions.size) {
    // Historical gaps need insertion before a later turn, especially when IDs
    // were reused. Reuse the manager's atomic replacement and boundary remapping.
    function* repaired(): Iterable<SessionEntry> {
      for (const entry of manager.iterateEntries()) {
        for (const message of insertions.get(entry.id) ?? [])
          yield { type: "message", id: randomUUID(), parentId: null, timestamp: entry.timestamp, message };
        yield entry;
      }
    }
    return { entries: repaired(), trailing: interrupted() };
  }
  return { trailing: interrupted() };
}

export async function recoverCanonicalToolCallsAsync(
  manager: SessionManager,
  messages: Message[],
): Promise<void> {
  const plan = canonicalRepairPlan(manager, messages);
  if (plan.entries) await manager.replaceEntriesAsync(plan.entries);
  for (const message of plan.trailing) await manager.appendEntryAsync({ type: "message", message });
}
