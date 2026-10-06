// Adapted from Pi (commit c20cb09772bf4e2590a316cb54514cef76df4293) Copyright (c) 2025 Mario Zechner. MIT license
import type { Message } from "ZPI-ai";
import { messageChars } from "ZPI-ai";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

export interface CompactionOptions {
  reserveTokens?: number;
  keepRecentTokens?: number;
}
export const summaryPrompt = `You are a context summarization assistant. Do NOT continue the conversation or execute tools. Return only the summary in this exact Markdown structure:
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context
Preserve concrete facts, paths, decisions, unfinished work and tool outcomes. Update any earlier summary instead of losing it.`;

type MessageEntry = Extract<SessionEntry, { type: "message" }>;
export function compactionBoundary(manager: SessionManager, keepRecentTokens: number, manual = false) {
  const entries = manager.getEntries();
  const previous = entries.findLast((entry) => entry.type === "compaction");
  const from =
    previous?.type === "compaction" ? entries.findIndex((e) => e.id === previous.firstKeptEntryId) : 0;
  const rows = entries
    .slice(from)
    .filter((e): e is MessageEntry => e.type === "message" && e.message.role !== "system");
  let cut = rows.length - 1;
  if (manual) {
    cut = rows.findLastIndex((e) => e.message.role === "user");
    const last = rows.at(-1)?.message;
    if (last?.role !== "assistant" || !["stop", "length"].includes(last.stopReason)) return undefined;
  } else {
    let tokens = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      tokens += Math.ceil(messageChars(rows[i].message) / 4);
      if (tokens > keepRecentTokens) {
        cut = Math.min(i + 1, rows.length - 1);
        break;
      }
      cut = i;
    }
  }
  // Keep the entire tool batch when its results straddle the desired boundary.
  while (cut > 0 && rows[cut]?.message.role === "toolResult") cut--;
  if (cut < 1 || !rows[cut] || !["user", "assistant"].includes(rows[cut].message.role)) return undefined;
  const messages = manager.buildSessionContext().messages.filter((m) => m.role !== "system");
  const prefixCount = messages.length - rows.length;
  return { firstKeptEntryId: rows[cut].id, older: messages.slice(0, prefixCount + cut), entries };
}
export function serializeConversation(messages: Message[]): string {
  return messages
    .map((message) => {
      let text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((block) => {
                if (block.type === "image") return `[Image (${block.mimeType}); visual data omitted]`;
                if (block.type === "text") return block.text;
                if (block.type === "thinking") return block.redacted ? "[Redacted thinking]" : block.thinking;
                return `${block.name}(${JSON.stringify(block.arguments)})`;
              })
              .join("\n");
      if (message.role === "toolResult" && text.length > 2000)
        text = `${text.slice(0, 2000)}\n[... ${text.length - 2000} more characters truncated]`;
      return `[${message.role}]: ${text}`;
    })
    .join("\n\n");
}
/** Scan retained JSONL so repeated summaries preserve the cumulative file lists. */
export function fileLists(entries: SessionEntry[]): string {
  const read = new Set<string>(),
    modified = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type !== "toolCall" || typeof block.arguments.path !== "string") continue;
      if (block.name === "read") read.add(block.arguments.path);
      if (block.name === "edit" || block.name === "write") modified.add(block.arguments.path);
    }
  }
  return `\n\n<read-files>\n${[...read]
    .filter((p) => !modified.has(p))
    .sort()
    .join("\n")}\n</read-files>\n\n<modified-files>\n${[...modified].sort().join("\n")}\n</modified-files>`;
}
export function isContextOverflow(message: string): boolean {
  if (/rate limit|too many requests|throttling|service unavailable/i.test(message)) return false;
  return /prompt (?:is )?too long|prompt exceeds max length|request_too_large|input is too long|exceeds (?:the )?(?:model'?s )?(?:maximum )?context|maximum context length|maximum prompt length|input token count.*exceeds|reduce the length of the messages|context window exceeds limit|exceeded model token limit|model_context_window_exceeded|context[_ ]length[_ ]exceeded|too many tokens|token limit exceeded/i.test(
    message,
  );
}
