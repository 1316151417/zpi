import type { SessionMentionSuggestion } from "../types.ts";
import { scoreMentionMatch } from "./skill-suggestions.ts";

// ZCode searches all sessions before applying its independent 20-result workspace cap.
export function filterSessionSuggestions(items: SessionMentionSuggestion[], query: string) {
  const normalized = query.trim().toLowerCase();
  const ranked = normalized
    ? items
        .map((item, index) => ({
          item,
          index,
          score: Math.min(
            scoreMentionMatch(item.name, normalized),
            scoreMentionMatch(item.sessionId, normalized) + 25,
            scoreMentionMatch(item.description, normalized) + 100,
            ...item.keywords.map((keyword) => scoreMentionMatch(keyword, normalized) + 300),
          ),
        }))
        .filter((item) => Number.isFinite(item.score))
        .sort((a, b) => a.score - b.score || a.index - b.index)
        .map(({ item }) => item)
    : items;
  const counts = new Map<string, number>();
  return ranked.filter((item) => {
    const count = counts.get(item.workspaceKey) ?? 0;
    if (count >= 20) return false;
    counts.set(item.workspaceKey, count + 1);
    return true;
  });
}
