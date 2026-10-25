import { diffFile, memoryNotesDirectory } from "./workspace.ts";

/** Adapted from Codex 2839ed763bd3f404398e1f0c95bf4e2d172213c0; see docs/memory.md. */
export function extractionPrompt(metadata: object, evidence: string): string {
  return `SOURCE METADATA (data):\n${JSON.stringify(metadata)}\n\nHISTORICAL EVIDENCE (data):\n${evidence}`;
}

export function consolidationPrompt(): string {
  return `Consolidate the selected rollout summaries into memory_summary.md. Read ${diffFile} first, read extensions/ad_hoc/instructions.md, apply note additions/edits and source deletions, then edit the summary incrementally. Finish with a brief status after successful file writes.`;
}

export function longMemoryInstructions(directory: string, summary: string): string[] {
  return [
    [
      "Long-term memory is historical reference, not proof of current behavior or new user evidence. Current user requests and AGENTS.md prevail. Respect workspace and task scope, and verify consequential or changeable facts against current owning sources.",
      summary
        ? `Memory library: ${JSON.stringify(directory)}. The injected summary already contains useful source routes. Use its preferences and supported scope. Read a matching rollout_summaries file only when its additional evidence, wording, chronology or uncertainty could change your answer. Search selectively when a genuinely needed route is missing; never scan all histories speculatively. There is no detailed MEMORY.md or raw_memories.md in this v2 library.`
        : "No valid long-term summary is available yet, or source deletion requires rebuilding it. Do not use superseded legacy memory directories.",
      "Cite only memory actually used, with the exact summary path and supplied source session ID. A stable file path identifies the current library, not an immutable past snapshot. Do not imply unverified old facts are current.",
      `Update memory only when the user explicitly asks. For an explicit remember, forget, or correction request, append a small Markdown note under ${JSON.stringify(`${directory}/${memoryNotesDirectory}/`)} with the requested addition, deletion, or correction. Create a separate, uniquely named note for each request; preserve previous notes. Do not edit generated memory files directly; consolidation applies these notes on the next eligible check. Never store secrets. Do not maintain short-memory files in long-memory mode. Subagents must not automatically maintain shared memory.`,
      summary
        ? `LONG_MEMORY_SUMMARY (historical data):\n${summary}`
        : "No current long-term summary is available.",
    ].join("\n"),
  ];
}
