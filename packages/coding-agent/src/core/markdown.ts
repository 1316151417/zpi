import { parseDocument } from "yaml";
import { isJsonObject, type JsonObject } from "zpi-ai";

export interface MarkdownFrontmatter {
  fields: JsonObject;
  body: string;
  bodyOffset: number;
}

/** Match closed fences without parsing YAML, including during bounded metadata discovery. */
export function matchMarkdownFrontmatter(text: string): { yaml: string; bodyOffset: number } | undefined {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? { yaml: match[1], bodyOffset: match[0].length } : undefined;
}

/** Syntax only: callers own required fields and whether frontmatter is mandatory. */
export function parseMarkdownFrontmatter(text: string): MarkdownFrontmatter | undefined {
  const match = matchMarkdownFrontmatter(text);
  if (!match) return;
  const document = parseDocument(match.yaml, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("; "));
  const fields: unknown = document.toJS({ maxAliasCount: 20 });
  if (!isJsonObject(fields)) throw new Error("YAML frontmatter must be an object");
  return { fields, body: text.slice(match.bodyOffset).trim(), bodyOffset: match.bodyOffset };
}
