import { decodeString } from "micromark-util-decode-string";
import type { Plugin } from "unified";

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
}

const windowsDestinationPattern = /^(?:[a-zA-Z]:[\\/]|\\)/u;

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
        node.data.hProperties = { ...node.data.hProperties, dataZPITarget: target };
      }
      node.children?.forEach(preserve);
    };
    preserve(tree as MarkdownNode);
  };
};
