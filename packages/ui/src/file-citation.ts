import { decodeString } from "micromark-util-decode-string";
import { type LinkContext, resolveLinkTarget } from "./link-target.ts";
import { type MarkdownFence, markdownFence } from "./markdown-fence.ts";

const quotes: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’" };
const starts = /(?<!:):{1,3}zcode-file-citation\s*\{/g;
interface Citation {
  start: number;
  end: number;
  path: string;
}
interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

function closingBrace(text: string, start: number): { end: number; quoted: boolean } {
  let quote = "",
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = "";
    } else if (quotes[c]) quote = quotes[c];
    else if (c === "}") return { end: i, quoted: false };
  }
  return { end: -1, quoted: Boolean(quote) };
}
function parameters(source: string): Record<string, string> | null {
  const values: Record<string, string> = {};
  let i = 0;
  while (i < source.length) {
    while (/[\s,]/.test(source[i] ?? "") && i < source.length) i++;
    if (i === source.length) break;
    const name = /^[a-z_][a-z\d_-]*/i.exec(source.slice(i))?.[0];
    if (!name) return null;
    i += name.length;
    while (/\s/.test(source[i] ?? "") && i < source.length) i++;
    if (source[i++] !== "=") return null;
    while (/\s/.test(source[i] ?? "") && i < source.length) i++;
    const opening = source[i],
      close = quotes[opening];
    let value = "";
    if (close) {
      i++;
      while (i < source.length && source[i] !== close) {
        const c = source[i++];
        if (c === "\\" && i < source.length) {
          const next = source[i++];
          value += next === opening || next === close || next === "\\" ? next : `\\${next}`;
        } else value += c;
      }
      if (source[i++] !== close) return null;
    } else {
      while (i < source.length && !/[\s,]/.test(source[i])) value += source[i++];
      if (!value) return null;
    }
    if (i < source.length && !/[\s,]/.test(source[i])) return null;
    values[name] = value;
  }
  return values;
}
export function extractFileCitationDirectives(text: string) {
  const citations: Array<{ start: number; end: number; path?: string; artifactKind?: string }> = [];
  let consumed = 0;
  for (const match of text.matchAll(starts)) {
    if (match.index < consumed) continue;
    const { end } = closingBrace(text, match.index + match[0].length);
    if (end < 0) continue;
    consumed = end + 1;
    const values = parameters(text.slice(match.index + match[0].length, end));
    citations.push({
      start: match.index,
      end: end + 1,
      path: values?.path?.trim() || undefined,
      artifactKind: values?.artifact_kind,
    });
  }
  return citations;
}
export function extractFileCitations(text: string): Citation[] {
  return extractFileCitationDirectives(text).flatMap((citation) =>
    citation.path ? [{ ...citation, path: citation.path }] : [],
  );
}
export function resolveFileCitationPreviewKind({
  path,
  artifactKind,
}: {
  path: string;
  artifactKind?: string;
}) {
  const extension = path.trim().toLowerCase().split(".").at(-1) ?? "";
  const kind =
    extension === "docx" || extension === "xlsx" || extension === "pptx" || extension === "pdf"
      ? extension
      : ["mp4", "mov", "webm", "m4v"].includes(extension)
        ? "video"
        : ["mp3", "wav", "m4a", "ogg", "opus", "flac", "weba"].includes(extension)
          ? "audio"
          : null;
  if (artifactKind === undefined) return kind;
  const kinds: Record<string, string> = {
    document: "docx",
    workbook: "xlsx",
    presentation: "pptx",
    audio: "audio",
    video: "video",
  };
  return kinds[artifactKind.trim().toLowerCase()] === kind ? kind : null;
}

function codeRanges(content: string): Array<[number, number]> {
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

export function projectFileCitations(text: string, streaming: boolean): string {
  if (!streaming) return text;
  let ranges: Array<[number, number]> | undefined;
  const protectedAt = (index: number) => {
    ranges ??= codeRanges(text);
    return ranges.some(([a, b]) => index >= a && index < b);
  };
  let hidden: number | undefined;
  for (const match of text.matchAll(starts)) {
    if (protectedAt(match.index)) continue;
    const start = match.index + match[0].length;
    const { end, quoted } = closingBrace(text, start);
    const tail = text.slice(start);
    const pending = /(?:^|[\s,])[a-z_][a-z\d_-]*\s*(?:=\s*)?$/i.exec(tail);
    const partialParameter = pending !== null && parameters(tail.slice(0, pending.index)) !== null;
    if (end < 0 && (quoted || parameters(tail) !== null || partialParameter)) hidden = match.index;
  }
  if (hidden !== undefined) return text.slice(0, hidden);
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== ":" || text[i - 1] === ":") continue;
    const suffix = text.slice(i);
    for (const count of [3, 2, 1]) {
      if (count === 1 && suffix.length < 6) continue;
      const prefix = `${":".repeat(count)}zcode-file-citation`;
      if (
        (prefix.startsWith(suffix) ||
          (suffix.startsWith(prefix) && /^\s*$/.test(suffix.slice(prefix.length)))) &&
        !protectedAt(i)
      )
        return text.slice(0, i);
    }
  }
  return text;
}
export function fileCitationRemarkPlugin(context: LinkContext) {
  return () => (tree: unknown, file: unknown) => {
    const source = String(file ?? "");
    const visit = (node: Node) => {
      if (
        !node.children ||
        ["code", "html", "image", "imageReference", "inlineCode", "link", "linkReference"].includes(node.type)
      )
        return;
      node.children = node.children.flatMap((child): Node[] => {
        if (child.type !== "text") {
          visit(child);
          return [child];
        }
        const value = child.value ?? "",
          nodes: Node[] = [];
        const start = child.position?.start?.offset,
          end = child.position?.end?.offset;
        const raw = start !== undefined && end !== undefined ? source.slice(start, end) : "";
        // Use original directive escapes only when the raw slice accounts for this complete text node.
        const preserved = raw && decodeString(raw) === value;
        const content = preserved ? raw : value;
        const visible = (text: string) => (preserved ? decodeString(text) : text);
        let cursor = 0;
        for (const citation of extractFileCitations(content)) {
          const target = resolveLinkTarget(citation.path, context);
          if (target?.kind !== "file") continue;
          if (citation.start > cursor)
            nodes.push({ type: "text", value: visible(content.slice(cursor, citation.start)) });
          nodes.push({
            type: "link",
            url: citation.path,
            children: [{ type: "text", value: target.path.split("/").at(-1) || citation.path }],
          });
          cursor = citation.end;
        }
        if (!cursor) return [child];
        if (cursor < content.length) nodes.push({ type: "text", value: visible(content.slice(cursor)) });
        return nodes;
      });
    };
    visit(tree as Node);
  };
}
