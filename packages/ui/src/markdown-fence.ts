export interface MarkdownFence {
  marker: string;
  length: number;
}

/** Return a valid opening or closing fence for the current Markdown code block. */
export function markdownFence(line: string, active: MarkdownFence | null): MarkdownFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[1][0],
    length = match[1].length,
    tail = match[2];
  if (active) {
    if (marker !== active.marker || length < active.length || tail.trim()) return null;
  } else if (marker === "`" && tail.includes("`")) return null;
  return { marker, length };
}
