import type { ThinkingLevel } from "ZPI-agent";
import type { ContextBreakdownItem, Model } from "ZPI-ai";
import { thinkingChoices } from "ZPI-ai";
import type { SessionEntry } from "./session-manager.ts";

export interface ContextUsage {
  contextWindow: number;
  inputTokens: number | null;
  percent: number | null;
  timestamp: number | null;
  source: "server usage" | "unknown";
  breakdown?: ContextBreakdownItem[];
  averageCacheHitRate?: number | null;
}
export function contextUsage(entries: SessionEntry[], model: Model): ContextUsage {
  const result: ContextUsage = {
    contextWindow: model.contextWindow,
    inputTokens: null,
    percent: null,
    timestamp: null,
    source: "unknown",
  };
  let cacheRead = 0,
    totalInput = 0;
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "model_change") {
      cacheRead = 0;
      totalInput = 0;
    }
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const m = entry.message;
    if (
      m.model !== model.id ||
      m.provider !== model.provider ||
      ["error", "aborted"].includes(m.stopReason) ||
      m.usageAvailable === false ||
      m.cacheUsageAvailable !== true
    )
      continue;
    cacheRead += m.usage.cacheRead;
    totalInput += m.usage.input + m.usage.cacheRead;
  }
  for (const entry of [...entries].reverse()) {
    if (entry.type === "compaction") break;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const m = entry.message;
    if (m.stopReason === "error" || m.stopReason === "aborted") continue;
    if (m.usageAvailable === false || (m.usageAvailable !== true && m.usage.totalTokens === 0)) continue;
    const inputTokens = m.usage.input + m.usage.cacheRead;
    return {
      contextWindow: model.contextWindow,
      inputTokens,
      percent: (inputTokens / model.contextWindow) * 100,
      timestamp: m.timestamp,
      source: "server usage",
      breakdown: m.contextBreakdown,
      averageCacheHitRate: totalInput > 0 ? cacheRead / totalInput : null,
    };
  }
  return result;
}
export function supportedThinkingLevels(model: Model): ThinkingLevel[] {
  return thinkingChoices(model);
}
