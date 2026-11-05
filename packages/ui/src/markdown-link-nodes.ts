import { decodeString } from "micromark-util-decode-string";
import type { Plugin } from "unified";
import { type LinkContext, resolveMarkdownLinkTarget } from "./link-target.ts";

interface MarkdownPoint {
  offset?: number;
}

interface MarkdownNode {
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
  identifier?: string;
  position?: { end?: MarkdownPoint; start?: MarkdownPoint };
  title?: string | null;
  type: string;
  url?: string;
  value?: string;
}

const windowsDestinationPattern = /^(?:[a-zA-Z]:[\\/]|\\)/u;
const localDestinationPattern = /^(?:\/|\.\.?[\\/]|~\/|[a-zA-Z]:[\\/]|\\\\)/u;

function spacedFileLinks(raw: string, context: LinkContext): MarkdownNode[] | null {
  const nodes: MarkdownNode[] = [];
  let cursor = 0,
    scanned = 0;
  for (const match of raw.matchAll(/(?<![\\!])\[((?:\\.|[^\\[\]\r\n])*)\]\(/gu)) {
    if (match.index < scanned) continue;
    const start = match.index + match[0].length;
    let end = start,
      depth = 1;
    for (; end < raw.length; end++) {
      const character = raw[end];
      if (character === "\r" || character === "\n") break;
      if (character === "\\" && /[()\\]/.test(raw[end + 1] ?? "")) {
        end++;
        continue;
      }
      if (character === "(") depth++;
      else if (character === ")" && --depth === 0) break;
    }
    if (depth || end === raw.length) continue;
    scanned = end + 1;
    const destination = raw.slice(start, end);
    if (
      !localDestinationPattern.test(destination) ||
      !/[ \t]/.test(destination) ||
      /[<>\r\n]/.test(destination) ||
      /[ \t]$/.test(destination) ||
      /[ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\))$/.test(destination)
    )
      continue;
    const url = decodeString(
      windowsDestinationPattern.test(destination) ? destination.replaceAll("\\", "\\\\") : destination,
    );
    if (resolveMarkdownLinkTarget(url, context)?.kind !== "file") continue;
    if (match.index > cursor)
      nodes.push({ type: "text", value: decodeString(raw.slice(cursor, match.index)) });
    nodes.push({ type: "link", url, children: [{ type: "text", value: decodeString(match[1]) }] });
    cursor = end + 1;
  }
  if (!cursor) return null;
  if (cursor < raw.length) nodes.push({ type: "text", value: decodeString(raw.slice(cursor)) });
  return nodes;
}

export function spacedFileLinkRemarkPlugin(context: LinkContext = {}) {
  return () => (tree: unknown, file: unknown) => {
    const source = String(file ?? "");
    const visit = (node: MarkdownNode) => {
      if (
        !node.children ||
        ["code", "inlineCode", "html", "link", "linkReference", "image", "imageReference"].includes(node.type)
      )
        return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text") {
          visit(child);
          return [child];
        }
        const start = child.position?.start?.offset,
          end = child.position?.end?.offset;
        if (start === undefined || end === undefined) return [child];
        const raw = source.slice(start, end);
        // CommonMark 把含空格的裸路径留成文本；只修复可完整还原的文本节点，保留原始路径和代码语义。
        return decodeString(raw) === child.value ? (spacedFileLinks(raw, context) ?? [child]) : [child];
      });
    };
    visit(tree as MarkdownNode);
  };
}

function extractRawDestination(node: MarkdownNode, slice: string): string | null {
  let target: string;
  if (node.type === "definition") {
    const marker = slice.indexOf("]:");
    if (marker < 0) return null;
    target = slice.slice(marker + 2).trim();
  } else {
    if (!slice.endsWith(")")) return null;
    const marker = slice.lastIndexOf("](");
    if (marker < 0) return null;
    target = slice.slice(marker + 2, -1).trim();
  }
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

function recoverRawDestination(node: MarkdownNode, source: string): string | null {
  const url = node.url;
  if (typeof url !== "string" || !windowsDestinationPattern.test(url)) return null;
  if (node.title !== null && node.title !== undefined) return null;

  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return null;

  const raw = extractRawDestination(node, source.slice(start, end));
  if (raw === null || !raw || raw === url) return null;
  if (decodeString(raw) !== url) return null;
  // Decode entities while keeping native Windows path separators literal.
  return decodeString(raw.replaceAll("\\", "\\\\"));
}

export const markdownLinkRemarkPlugin: Plugin = function markdownLinkRemarkPlugin() {
  return (tree: unknown, file: unknown) => {
    const source = String(file ?? "");
    if (!source) return;

    const definitions = new Map<string, string>();
    const visit = (node: MarkdownNode): void => {
      if (node.type === "link" || node.type === "image" || node.type === "definition") {
        const raw = recoverRawDestination(node, source);
        if (raw !== null) node.url = raw;
      }

      if (node.type === "definition" && node.identifier && node.url)
        definitions.set(node.identifier, node.url);
      node.children?.forEach(visit);
    };

    visit(tree as MarkdownNode);
    const preserve = (node: MarkdownNode) => {
      const target = node.url ?? (node.identifier ? definitions.get(node.identifier) : undefined);
      if (target && ["link", "image", "linkReference", "imageReference"].includes(node.type)) {
        node.data ??= {};
        node.data.hProperties = { ...node.data.hProperties, dataZpiTarget: target };
      }
      node.children?.forEach(preserve);
    };
    preserve(tree as MarkdownNode);
  };
};
