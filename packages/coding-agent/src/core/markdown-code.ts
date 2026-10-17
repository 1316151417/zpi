export interface MarkdownFence {
  marker: string;
  length: number;
}

/** Return a valid opening or closing fence for the current Markdown code block. */
export function markdownFence(line: string, active: MarkdownFence | null): MarkdownFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, ""));
  if (!match) return null;
  const marker = match[1][0],
    length = match[1].length,
    tail = match[2];
  if (active) {
    if (marker !== active.marker || length < active.length || tail.trim()) return null;
  } else if (marker === "`" && tail.includes("`")) return null;
  return { marker, length };
}

export function codeRanges(content: string, includeInline = true): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  let fence: (MarkdownFence & { start: number }) | null = null;
  let lineStart = 0;

  while (lineStart < content.length) {
    const newlineIndex = content.indexOf("\n", lineStart);
    const lineEnd = newlineIndex < 0 ? content.length : newlineIndex + 1;
    const line = content.slice(lineStart, newlineIndex < 0 ? content.length : newlineIndex);
    const marker = markdownFence(line, fence);
    if (marker) {
      if (!fence) {
        fence = {
          ...marker,
          start: lineStart,
        };
      } else {
        blocks.push([fence.start, lineEnd]);
        fence = null;
      }
    }
    if (!fence && /^(?: {4}|\t)/.test(line)) blocks.push([lineStart, lineEnd]);
    lineStart = lineEnd;
  }
  if (fence) blocks.push([fence.start, content.length]);

  for (const match of content.matchAll(/<(code|pre)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi)) {
    const start = match.index ?? 0;
    blocks.push([start, start + (match[0]?.length ?? 0)]);
  }

  if (!includeInline) return blocks;
  const ranges = [...blocks];
  const isBlock = (index: number) => blocks.some(([start, end]) => index >= start && index < end);
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "`" || isBlock(index)) continue;
    let markerLength = 1;
    while (content[index + markerLength] === "`") markerLength += 1;
    const marker = "`".repeat(markerLength);
    const closingIndex = content.indexOf(marker, index + markerLength);
    if (closingIndex < 0 || isBlock(closingIndex)) {
      ranges.push([index, closingIndex < 0 ? content.length : closingIndex]);
      index += markerLength - 1;
      continue;
    }
    ranges.push([index, closingIndex + markerLength]);
    index = closingIndex + markerLength - 1;
  }

  return ranges;
}
