// Adapted from ZCode mentionSearch / workspaceFileSearch; see THIRD_PARTY_NOTICES.md.
/** The caller normalizes the query and applies any field-specific weighting. */
export function fuzzyScore(text: string, query: string, allowSubsequence = true): number {
  const value = text.trim().toLowerCase();
  if (!value) return Number.POSITIVE_INFINITY;
  if (value.startsWith(query)) return value.length - query.length;
  const substring = value.indexOf(query);
  if (substring !== -1) return 100 + substring;
  if (!allowSubsequence) return Number.POSITIVE_INFINITY;
  let score = 200;
  let start = 0;
  for (const char of query) {
    const index = value.indexOf(char, start);
    if (index === -1) return Number.POSITIVE_INFINITY;
    score += index - start;
    start = index + 1;
  }
  return score + value.length - query.length;
}
