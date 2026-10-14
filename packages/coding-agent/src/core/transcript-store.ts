import type { ThinkingLevel } from "zpi-agent";
import type { Message } from "zpi-ai";
import type { SessionEntry, SessionHeader } from "./session-manager.ts";

/** A fixed generation and inclusive sequence watermark. Sequences start at 1. */
export interface TranscriptSnapshot {
  generation: string;
  endSeq: number;
}
export interface IndexedSessionEntry {
  seq: number;
  entry: SessionEntry;
}
export interface TranscriptState {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: ThinkingLevel;
  lastThinkingLevel: ThinkingLevel;
  hasThinkingEntry: boolean;
  lastMessageSeq: number;
  lastCompactionSeq: number;
  name?: string;
}
export interface TranscriptContextPlan {
  snapshot: TranscriptSnapshot;
  /** Latest compaction at the snapshot watermark, if any. */
  compaction?: IndexedSessionEntry;
  /** Inclusive sequence of first retained entry; 1 when there is no compaction. */
  firstKeptSeq: number;
}
/**
 * SDK-neutral, indexed transcript access. Implementations own all writes and recovery.
 * Readers MUST honor the snapshot generation and watermark, rejecting stale generations.
 * Ranges are inclusive, ordered, lazy iterators; no implicit whole-transcript materialization.
 * Append must durably persist the record before publishing its index/watermark.
 */
export interface TranscriptStore {
  getHeader(): SessionHeader;
  getFile(): string | undefined;
  snapshot(): TranscriptSnapshot;
  getStateAt(snapshot: TranscriptSnapshot): TranscriptState;
  getTail(snapshot: TranscriptSnapshot): IndexedSessionEntry | undefined;
  readEntryById(id: string, snapshot: TranscriptSnapshot): IndexedSessionEntry | undefined;
  readRange(
    startSeq: number,
    endSeq: number,
    snapshot: TranscriptSnapshot,
    types?: readonly SessionEntry["type"][],
  ): Iterable<IndexedSessionEntry>;
  getContextPlan(snapshot: TranscriptSnapshot): TranscriptContextPlan;
  /** Each group contains only an unresolved journal's updates, anchor and canonical turn. */
  readUnresolvedToolJournals(snapshot: TranscriptSnapshot): Iterable<SessionEntry[]>;
  append(entry: SessionEntry): void;
  /** Implementations stage a fresh generation; preserve the old one on any failure. */
  replace(header: SessionHeader, entries: Iterable<SessionEntry>): void;
}
export interface MessageProvenance {
  entryId: string;
  seq: number;
  kind: "message" | "compaction-system" | "compaction-summary";
}
const provenance = new WeakMap<Message, MessageProvenance>();
export function setMessageProvenance(message: Message, source: MessageProvenance): void {
  provenance.set(message, source);
}
export function getMessageProvenance(message: Message): MessageProvenance | undefined {
  return provenance.get(message);
}

/** Current product choices are separate from historical transcript checkpoints. */
export interface SessionCurrentState {
  get(): Pick<TranscriptState, "model" | "thinkingLevel" | "lastThinkingLevel" | "name">;
  setModel(provider: string, modelId: string): void;
  setThinkingLevel(level: ThinkingLevel): void;
  setName(name: string): void;
}
