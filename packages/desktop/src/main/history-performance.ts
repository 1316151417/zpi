import { isJsonObject } from "zpi-ai";
import { type ModelPerformanceTotals, type SessionEntry, SessionPerformance } from "zpi-coding-agent";

export const sideChatGuard =
  "The preceding conversation was inherited from the parent task for reference only. Do not continue the parent's active work automatically; answer only new questions sent in this side chat. Modify the workspace only when the user explicitly asks you to do so in this side chat.";

/** Count original run boundaries before side-chat inheritance hides desktop metadata. */
export function historyPerformance(
  entries: Iterable<{ entry: SessionEntry }>,
  initial?: ModelPerformanceTotals,
): ModelPerformanceTotals {
  const stats = new SessionPerformance(() => {}, initial);
  let inRun = false;
  for (const { entry } of entries) {
    if (entry.type === "custom" && entry.customType === "zpi.run" && isJsonObject(entry.data)) {
      if (entry.data.phase === "start") {
        stats.begin();
        inRun = true;
      }
      if (entry.data.phase === "end") inRun = false;
    }
    if (entry.type === "message") {
      if (entry.message.role === "user" && !inRun) stats.begin();
      if (entry.message.role === "assistant") stats.request().finish(false, entry.message);
    }
    if (entry.type === "compaction" && entry.usage)
      stats.request().finish(false, { usage: entry.usage, usageAvailable: true });
  }
  return stats.snapshot;
}
