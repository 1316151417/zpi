import { fuzzyScore } from "../fuzzy-search.ts";
import type { InputSuggestion } from "../types.ts";

// ZCode mentionSearch: prefix, substring, then English subsequence; Chinese stays contiguous.
export function scoreMentionMatch(text: string, query: string): number {
  return fuzzyScore(text, query, !/\p{Script=Han}/u.test(query));
}

export function filterSkillSuggestions(suggestions: InputSuggestion[], query: string): InputSuggestion[] {
  const skills = suggestions.filter((suggestion) => suggestion.group === "Skill");
  const normalized = query.trim().toLowerCase();
  if (!normalized) return skills.slice(0, 1000);
  return skills
    .map((suggestion, index) => ({
      suggestion,
      index,
      score: Math.min(
        scoreMentionMatch(suggestion.name, normalized),
        scoreMentionMatch(suggestion.description, normalized) + 100,
      ),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, 1000)
    .map((item) => item.suggestion);
}
