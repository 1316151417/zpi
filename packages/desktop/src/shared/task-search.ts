// Adapted from ZCode taskIndexRepo search snippets (Apache-2.0).
export interface TaskSearchText {
  runId: string;
  text: string;
}
export interface TaskSearchSnippet {
  text: string;
  runId?: string;
  matchBefore?: string;
  matchAfter?: string;
}
export function buildTaskSearchSnippets(
  segments: Iterable<TaskSearchText>,
  query: string,
): TaskSearchSnippet[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const snippets: TaskSearchSnippet[] = [];
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 140);
  let fallback = "";
  for (const { runId, text } of segments) {
    const folded = text.toLocaleLowerCase();
    // Map only visited matches back to the original text. Expanded lowercase graphemes
    // (İ -> i + combining dot) must not require arrays proportional to the whole history.
    const graphemes =
      folded.length !== text.length ? new Intl.Segmenter().segment(text)[Symbol.iterator]() : undefined;
    let grapheme: Intl.SegmentData | undefined;
    let foldedEnd = 0;
    const originalOffset = (offset: number, after = false) => {
      if (!graphemes) return offset + Number(after);
      while (foldedEnd <= offset) {
        grapheme = graphemes.next().value;
        if (!grapheme) return text.length;
        foldedEnd += grapheme.segment.toLocaleLowerCase().length;
      }
      return (grapheme?.index ?? 0) + (after ? (grapheme?.segment.length ?? 0) : 0);
    };
    let from = 0;
    let previousEnd = 0;
    while (from < folded.length) {
      const match = folded.indexOf(needle, from);
      if (match < 0) break;
      const matchStart = originalOffset(match);
      const matchEnd = originalOffset(match + needle.length - 1, true);
      const start = Math.max(0, matchStart - 20);
      const end = Math.min(text.length, matchEnd + 72);
      if (start >= previousEnd) {
        snippets.push({
          text: normalize(`${start ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`),
          runId,
          matchBefore: text.slice(start, matchStart),
          matchAfter: text.slice(matchEnd, end),
        });
        if (snippets.length === 4) return snippets;
        previousEnd = end;
      }
      from = match + needle.length;
    }
    if (!snippets.length) fallback ||= normalize(text);
  }
  return snippets.length ? snippets : fallback ? [{ text: fallback }] : [];
}
