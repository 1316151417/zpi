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
  segments: readonly TaskSearchText[],
  query: string,
): TaskSearchSnippet[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const text = segments.map((segment) => segment.text).join("\n");
  if (!text.trim()) return [];
  const folded = text.toLocaleLowerCase();
  const starts: number[] = [];
  const ends: number[] = [];
  if (folded.length !== text.length) {
    // Case conversion can expand a grapheme (İ -> i + combining dot).
    // Keep match offsets in the original text, including when a match ends inside an expansion.
    for (const { segment, index } of new Intl.Segmenter().segment(text)) {
      const length = segment.toLocaleLowerCase().length;
      for (let i = 0; i < length; i++) {
        starts.push(index);
        ends.push(index + segment.length);
      }
    }
  }
  const snippets: TaskSearchSnippet[] = [];
  const ranges: { start: number; end: number }[] = [];
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 140);
  let from = 0;
  while (snippets.length < 4 && from < folded.length) {
    const match = folded.indexOf(needle, from);
    if (match < 0) break;
    const matchStart = starts[match] ?? match;
    const matchEnd = ends[match + needle.length - 1] ?? match + needle.length;
    const start = Math.max(0, matchStart - 20);
    const end = Math.min(text.length, matchEnd + 72);
    if (!ranges.some((range) => Math.min(range.end, end) > Math.max(range.start, start))) {
      let offset = 0;
      const segment = segments.find((segment) => {
        const contains = matchStart >= offset && matchStart < offset + segment.text.length;
        offset += segment.text.length + 1;
        return contains;
      });
      const segmentStart = segment ? offset - segment.text.length - 1 : 0;
      const localMatch = matchStart - segmentStart;
      snippets.push({
        text: normalize(`${start ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`),
        runId: segment?.runId,
        matchBefore: segment?.text.slice(Math.max(0, localMatch - 20), localMatch),
        matchAfter: segment?.text.slice(matchEnd - segmentStart, matchEnd - segmentStart + 72),
      });
      ranges.push({ start, end });
    }
    from = match + needle.length;
  }
  return snippets.length ? snippets : [{ text: normalize(text) }];
}
