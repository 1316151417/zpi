import type { InputSuggestion } from "../types.ts";

// ZCode mentionSearch: prefix, substring, then English subsequence; Chinese stays contiguous.
function score(text: string, query: string): number {
  const value = text.trim().toLowerCase();
  if (!value) return Number.POSITIVE_INFINITY;
  if (value.startsWith(query)) return value.length - query.length;
  const substring = value.indexOf(query);
  if (substring !== -1) return 100 + substring;
  if (/\p{Script=Han}/u.test(query)) return Number.POSITIVE_INFINITY;
  let result = 200;
  let start = 0;
  for (const char of query) {
    const index = value.indexOf(char, start);
    if (index === -1) return Number.POSITIVE_INFINITY;
    result += index - start;
    start = index + 1;
  }
  return result + value.length - query.length;
}

export function filterSkillSuggestions(suggestions: InputSuggestion[], query: string): InputSuggestion[] {
  const skills = suggestions.filter((suggestion) => suggestion.group === "Skill");
  const normalized = query.trim().toLowerCase();
  if (!normalized) return skills.slice(0, 1000);
  return skills
    .map((suggestion, index) => ({
      suggestion,
      index,
      score: Math.min(score(suggestion.name, normalized), score(suggestion.description, normalized) + 100),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, 1000)
    .map((item) => item.suggestion);
}
