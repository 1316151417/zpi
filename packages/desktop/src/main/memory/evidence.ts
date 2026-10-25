import { isJsonObject } from "zpi-ai";
import type { SessionEntry } from "zpi-coding-agent";
import { sessionReferenceTranscriptReverse } from "../session-references.ts";

// Memory reads and writes are derivative material, never fresh preference evidence.
const memoryMaterial =
  /(?:^|[\s/\\"'])MEMORY\.md\b|memory_summary\.md|raw_memories\.md|memory_notes\.md|rollout_summaries[/\\]|extensions[/\\]ad_hoc[/\\]/i;
const memoryPath =
  /(?:^|[/\\])(?:MEMORY\.md|memory_summary\.md|raw_memories\.md|memory_notes\.md)$|(?:^|[/\\])rollout_summaries(?:[/\\]|$)|(?:^|[/\\])extensions[/\\]ad_hoc(?:[/\\]|$)/i;

function memoryOperation(name: string, args: unknown): boolean {
  if (!isJsonObject(args)) return false;
  if (name === "bash") return typeof args.command === "string" && memoryMaterial.test(args.command);
  if (!["read", "write", "edit"].includes(name)) return false;
  return [args.path, args.file_path].some((path) => typeof path === "string" && memoryPath.test(path));
}

/** Remove recognizable credential values while retaining ordinary discussion about authentication. */
function redactEvidence(text: string): string {
  return text
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(https?:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [REDACTED]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g,
      "[REDACTED]",
    )
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[REDACTED]")
    .replace(
      /(["']?(?:api[_ -]?key|(?:access|refresh|id|auth)[_-]?token|authorization|cookie|password|client[_-]?secret)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/g,
      "$1[REDACTED]",
    );
}

export function memoryEvidence(title: string, id: string, newestFirst: Iterable<SessionEntry>): string {
  const recent: SessionEntry[] = [];
  let clipped = false;
  for (const entry of newestFirst) {
    if (recent.length === 4000) {
      clipped = true;
      break;
    }
    recent.push(entry);
  }
  const excludedCalls = new Set<string>();
  const evidence: SessionEntry[] = [];
  // Ignore any partial run at the beginning of the bounded window until its human input.
  let humanRun = false;
  for (const entry of recent.reverse()) {
    if (entry.type === "custom" && entry.customType === "zpi.run" && isJsonObject(entry.data)) {
      if (entry.data.phase === "start") humanRun = !entry.data.subagentNotification;
      if (humanRun) evidence.push(entry);
      continue;
    }
    if (!humanRun || entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      const content = entry.message.content.filter((part) => {
        if (part.type !== "toolCall" || !memoryOperation(part.name, part.arguments)) return true;
        excludedCalls.add(part.id);
        return false;
      });
      evidence.push({ ...entry, message: { ...entry.message, content } });
    } else if (entry.message.role === "toolResult" && !excludedCalls.has(entry.message.toolCallId)) {
      evidence.push(entry);
    }
  }
  return redactEvidence(
    [
      "Evidence policy: only User sections and actual human answers in AskUserQuestion results can establish user preferences. Suggested options, skipped questions and timeouts are not answers. Assistant proposals, tool output, and recollections are not user endorsement. Assistant prose may repeat injected memories; do not turn recollections into new evidence. Never infer a global preference from a one-off request.",
      clipped ? "[Evidence limited to the latest 4000 history records.]" : "",
      sessionReferenceTranscriptReverse(title.slice(0, 200), id.slice(0, 200), evidence.reverse()),
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}
