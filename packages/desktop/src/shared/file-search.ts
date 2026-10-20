// ZCode workspaceFileSearch: basename, relative path, then absolute-path keywords.
export function fuzzyScore(text: string, query: string): number {
  const normalized = text.trim().toLowerCase();
  if (normalized.startsWith(query)) return normalized.length - query.length;
  const substring = normalized.indexOf(query);
  if (substring !== -1) return 100 + substring;
  let score = 200;
  let start = 0;
  for (const char of query) {
    const index = normalized.indexOf(char, start);
    if (index === -1) return Number.POSITIVE_INFINITY;
    score += index - start;
    start = index + 1;
  }
  return score + normalized.length - query.length;
}
