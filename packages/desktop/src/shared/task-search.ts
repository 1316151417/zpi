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
  const snippets: TaskSearchSnippet[] = [];
  const ranges: { start: number; end: number }[] = [];
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 140);
  let from = 0;
  while (snippets.length < 4 && from < folded.length) {
    const match = folded.indexOf(needle, from);
    if (match < 0) break;
    const start = Math.max(0, match - 20);
    const end = Math.min(text.length, match + needle.length + 72);
    if (!ranges.some((range) => Math.min(range.end, end) > Math.max(range.start, start))) {
      let offset = 0;
      const segment = segments.find((segment) => {
        const contains = match >= offset && match < offset + segment.text.length;
        offset += segment.text.length + 1;
        return contains;
      });
      const segmentStart = segment ? offset - segment.text.length - 1 : 0;
      const localMatch = match - segmentStart;
      snippets.push({
        text: normalize(`${start ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`),
        runId: segment?.runId,
        matchBefore: segment?.text.slice(Math.max(0, localMatch - 20), localMatch),
        matchAfter: segment?.text.slice(localMatch + needle.length, localMatch + needle.length + 72),
      });
      ranges.push({ start, end });
    }
    from = match + needle.length;
  }
  return snippets.length ? snippets : [{ text: normalize(text) }];
}
