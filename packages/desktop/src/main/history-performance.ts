import { isJsonObject } from "zpi-ai";
import { type ModelPerformanceTotals, type SessionEntry, SessionPerformance } from "zpi-coding-agent";

export const sideChatGuard =
  "The preceding conversation was inherited from the parent task for reference only. Do not continue the parent's active work automatically; answer only new questions sent in this side chat. Modify the workspace only when the user explicitly asks you to do so in this side chat.";

/** Incrementally count original run boundaries before inheritance hides desktop metadata. */
export class HistoryPerformance {
  private readonly stats: SessionPerformance;
  private inRun = false;
  constructor(initial?: ModelPerformanceTotals) {
    this.stats = new SessionPerformance(() => {}, initial);
  }
  add(entry: SessionEntry): void {
    if (entry.type === "custom" && entry.customType === "zpi.run" && isJsonObject(entry.data)) {
      if (entry.data.phase === "start") {
        this.stats.begin();
        this.inRun = true;
      }
      if (entry.data.phase === "end") this.inRun = false;
    }
    if (entry.type === "message") {
      if (entry.message.role === "user" && !this.inRun) this.stats.begin();
      if (entry.message.role === "assistant") this.stats.request().finish(false, entry.message);
    }
    if (entry.type === "compaction" && entry.usage)
      this.stats.request().finish(false, { usage: entry.usage, usageAvailable: true });
  }
  get snapshot(): ModelPerformanceTotals {
    return this.stats.snapshot;
  }
}

export function historyPerformance(
  entries: Iterable<{ entry: SessionEntry }>,
  initial?: ModelPerformanceTotals,
): ModelPerformanceTotals {
  const stats = new HistoryPerformance(initial);
  for (const { entry } of entries) stats.add(entry);
  return stats.snapshot;
}
