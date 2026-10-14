/** Frozen v1 journal reducer, isolated from runtime recovery and external execution. */
import { createHash } from "node:crypto";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "zpi-ai";
import { isJsonObject } from "zpi-ai";
import {
  maxSessionEntryBytes,
  validateMessage,
} from "../../packages/coding-agent/src/core/record-validation.ts";
import type { LegacyEntries, Row } from "./legacy.ts";

const JOURNAL_TYPE = "zpi.streaming_tools";
interface Journal {
  id: string;
  anchorId: string | null;
  assistant: AssistantMessage;
  results: ToolResultMessage[];
}

/** History, results and additions stay on disk; each declaration is bounded by the record limit. */
export function* recoverLegacyJournals(
  entries: LegacyEntries,
  migrationId: string,
  recoveryAt: string,
): IterableIterator<Row> {
  const db = entries.db;
  if (!db.prepare("SELECT 1 FROM journal_updates LIMIT 1").get()) {
    yield* entries;
    return;
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS recovery_message_role ON entries(
      json_extract(data, '$.type'), json_extract(data, '$.message.role'), seq
    );
    CREATE TABLE IF NOT EXISTS recovery_additions(
      after_seq INTEGER NOT NULL, ordinal INTEGER PRIMARY KEY, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS recovery_additions_order ON recovery_additions(after_seq, ordinal);
    CREATE TABLE IF NOT EXISTS recovery_results(call_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recovery_calls(call_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS recovery_calls_order ON recovery_calls(ordinal);
  `);
  const updates = db.prepare("SELECT seq, data FROM journal_updates WHERE journal_id = ? ORDER BY seq");
  const anchorEntry = db.prepare("SELECT seq FROM entries WHERE id = ?");
  const canonicalEntry = db.prepare(`
    SELECT seq, data FROM entries
    WHERE seq > ? AND json_extract(data, '$.type') = 'message'
      AND json_extract(data, '$.message.role') = 'assistant'
      AND EXISTS (
        SELECT 1 FROM json_each(entries.data, '$.message.content') AS declaration
        JOIN recovery_calls AS pending ON json_extract(declaration.value, '$.id') = pending.call_id
        WHERE json_extract(declaration.value, '$.type') = 'toolCall'
      )
    ORDER BY seq LIMIT 1
  `);
  const nextAssistant = db.prepare(`
    SELECT seq FROM entries WHERE seq > ? AND json_extract(data, '$.type') = 'message'
      AND json_extract(data, '$.message.role') = 'assistant' ORDER BY seq LIMIT 1
  `);
  const pairedResults = db.prepare(`
    SELECT seq, json_extract(data, '$.message.toolCallId') AS call_id FROM entries
    WHERE seq > ? AND seq < ? AND json_extract(data, '$.type') = 'message'
      AND json_extract(data, '$.message.role') = 'toolResult'
      AND json_extract(data, '$.message.toolCallId') IN (SELECT value FROM json_each(?))
    ORDER BY seq
  `);
  const saveCall = db.prepare(
    "INSERT OR IGNORE INTO recovery_calls(call_id, ordinal, data) VALUES (?, ?, ?)",
  );
  const savedCalls = db.prepare("SELECT data FROM recovery_calls ORDER BY ordinal");
  const saveResult = db.prepare(
    "INSERT INTO recovery_results(call_id, data) VALUES (?, ?) ON CONFLICT(call_id) DO UPDATE SET data=excluded.data",
  );
  const savedResult = db.prepare("SELECT data FROM recovery_results WHERE call_id = ?");
  const insertionEntry = db.prepare("SELECT id FROM entries WHERE seq = ?");
  const add = db.prepare("INSERT INTO recovery_additions(after_seq, ordinal, data) VALUES (?, ?, ?)");
  const stableId = (id: string, ordinal: number) =>
    `migration-${createHash("sha256").update(`${migrationId}:${id}:${ordinal}`).digest("hex").slice(0, 32)}`;
  let order = 0;
  const recoveredTimestamp = Date.parse(recoveryAt);
  db.exec("SAVEPOINT recover_legacy_journals; DELETE FROM recovery_additions");
  try {
    // First-update order preserves the old reducer's ordering when journals share an insertion point.
    for (const pending of db
      .prepare(
        "SELECT journal_id, MIN(seq) AS first_seq FROM journal_updates GROUP BY journal_id ORDER BY first_seq",
      )
      .iterate()) {
      let journal: Journal | undefined;
      let insertion = 0;
      let callOrdinal = 0;
      db.exec("DELETE FROM recovery_results; DELETE FROM recovery_calls");
      for (const record of updates.iterate(String(pending.journal_id))) {
        const data: unknown = JSON.parse(String(record.data));
        if (!isJsonObject(data) || typeof data.id !== "string")
          throw new Error("Invalid streaming tool journal");
        validateMessage(data.assistant);
        if (
          data.assistant.role !== "assistant" ||
          !(data.anchorId === null || typeof data.anchorId === "string") ||
          !Array.isArray(data.results)
        )
          throw new Error("Invalid streaming tool journal");
        for (const result of data.results) {
          validateMessage(result);
          if (result.role !== "toolResult") throw new Error("Invalid streamed tool result");
        }
        const update = data as unknown as Journal;
        journal ??= { ...update, assistant: { ...update.assistant, content: [] }, results: [] };
        if (data.responseComplete === true) {
          journal.assistant = { ...update.assistant, content: [] };
          db.exec("DELETE FROM recovery_calls");
          callOrdinal = 0;
        }
        for (const call of update.assistant.content) {
          if (call.type !== "toolCall") throw new Error("Invalid streaming tool call");
          saveCall.run(call.id, callOrdinal++, JSON.stringify(call));
        }
        for (const result of update.results) saveResult.run(result.toolCallId, JSON.stringify(result));
        insertion = Number(record.seq);
      }
      if (!journal) continue;
      const anchor = journal.anchorId === null ? undefined : anchorEntry.get(journal.anchorId);
      if (journal.anchorId !== null && !anchor) throw new Error("Missing streaming journal anchor");
      const anchorSeq = anchor ? Number(anchor.seq) : 0;
      const canonical = canonicalEntry.get(anchorSeq);
      const canonicalSeq = canonical ? Number(canonical.seq) : 0;
      let calls: ToolCall[] = [];
      if (canonical) {
        const declaration = JSON.parse(String(canonical.data)) as { message: AssistantMessage };
        calls = declaration.message.content.filter((call) => call.type === "toolCall");
      } else {
        // Intermediate checkpoints can exceed a record and later reset or be superseded by canonical history.
        // Bound only the final declaration that must actually be synthesized.
        let callBytes = 2;
        for (const row of savedCalls.iterate()) {
          const data = String(row.data);
          callBytes += Buffer.byteLength(data) + (calls.length ? 1 : 0);
          if (callBytes > maxSessionEntryBytes)
            throw new Error("Recovered streaming assistant exceeds 8 MiB record limit");
          calls.push(JSON.parse(data) as ToolCall);
        }
        journal.assistant.content = calls;
      }
      const start = Math.max(anchorSeq, canonicalSeq);
      const end = nextAssistant.get(start);
      const paired = new Set<string>();
      insertion = Math.max(insertion, canonicalSeq);
      for (const result of pairedResults.iterate(
        start,
        end ? Number(end.seq) : Number.MAX_SAFE_INTEGER,
        JSON.stringify(calls.map((call) => call.id)),
      )) {
        paired.add(String(result.call_id));
        insertion = Math.max(insertion, Number(result.seq));
      }
      const parent = insertionEntry.get(insertion);
      if (!parent) throw new Error("Missing streaming journal insertion point");
      const parentId = String(parent.id);
      let ordinal = 0;
      const emit = (row: Row) => {
        const data = JSON.stringify({
          ...row,
          id: stableId(journal.id, ordinal++),
          parentId,
          timestamp: recoveryAt,
        });
        if (Buffer.byteLength(data) > maxSessionEntryBytes)
          throw new Error("Recovered streaming journal entry exceeds 8 MiB record limit");
        add.run(insertion, order++, data);
      };
      if (!canonical) emit({ type: "message", message: journal.assistant });
      for (const call of calls) {
        if (paired.has(call.id)) continue;
        const saved = savedResult.get(call.id);
        const message: Message = saved
          ? (JSON.parse(String(saved.data)) as ToolResultMessage)
          : {
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
              timestamp: recoveredTimestamp,
            };
        emit({ type: "message", message });
      }
      emit({ type: "custom", customType: JOURNAL_TYPE, data: { id: journal.id, committed: true } });
    }
    db.exec("RELEASE recover_legacy_journals");
  } catch (error) {
    db.exec("ROLLBACK TO recover_legacy_journals; RELEASE recover_legacy_journals");
    throw error;
  }
  // Merge two disk cursors instead of materializing the transcript or all recovered messages.
  const additions = db
    .prepare("SELECT after_seq, data FROM recovery_additions ORDER BY after_seq, ordinal")
    .iterate();
  try {
    let addition = additions.next();
    for (const entry of db.prepare("SELECT seq, data FROM entries ORDER BY seq").iterate()) {
      yield JSON.parse(String(entry.data)) as Row;
      while (!addition.done && Number(addition.value.after_seq) === Number(entry.seq)) {
        yield JSON.parse(String(addition.value.data)) as Row;
        addition = additions.next();
      }
    }
  } finally {
    additions.return?.();
  }
}
