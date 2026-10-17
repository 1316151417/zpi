import { codeRanges } from "./markdown-code.ts";

export interface Mention {
  kind: "file" | "skill" | "session";
  label: string;
  path: string;
  start: number;
  end: number;
  markdown: string;
}
const pattern = /\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)])*))\)/g;
const unescapeMarkdown = (value: string) => value.replace(/\\(.)/gs, "$1");
export function buildMentionMarkdown(label: string, path: string): string {
  const title = label.replace(/\\/g, "\\\\").replace(/[[\]]/g, "\\$&");
  const target = path.replace(/\\/g, "\\\\").replace(/[<>]/g, "\\$&");
  return `[${title}](${/[\s()<>]/.test(path) ? `<${target}>` : target})`;
}
// ZCode's canonical # destination, adapted to ZPI's UUID session identities.
const sessionTarget = /^#(?:sess_[a-zA-Z0-9._-]+|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i;
export function buildSessionMentionMarkdown(sessionId: string, label?: string): string {
  const title = label?.trim();
  return title && title !== sessionId ? buildMentionMarkdown(`#${title}`, `#${sessionId}`) : `#${sessionId}`;
}
export function extractSessionReferences(text: string): string[] {
  return [
    ...new Set(
      parseMentions(text)
        .filter((mention) => mention.kind === "session")
        .map((mention) => mention.path.slice(1)),
    ),
  ];
}
export function parseMentions(text: string): Mention[] {
  const result: Mention[] = [];
  const links = [...text.matchAll(pattern)];
  const code = codeRanges(text);
  const inCode = (index: number) => code.some(([start, end]) => index >= start && index < end);
  for (const match of links) {
    if (inCode(match.index)) continue;
    const label = unescapeMarkdown(match[1]),
      path = unescapeMarkdown(match[2] ?? match[3]);
    const session = sessionTarget.test(path);
    if (!session && !/^(?:\/|\.\.?[\\/]|[a-z]:[\\/]|\\\\)/i.test(path)) continue;
    result.push({
      kind: session ? "session" : label.startsWith("$") ? "skill" : "file",
      label: label.replace(session ? /^#/ : /^[$@]/, ""),
      path,
      start: match.index,
      end: match.index + match[0].length,
      markdown: match[0],
    });
  }
  for (const match of text.matchAll(
    /(^|\s)(#(?:sess_[a-zA-Z0-9._-]+|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}))(?=$|\s)/gi,
  )) {
    const start = match.index + match[1].length;
    if (inCode(start)) continue;
    if (links.some((link) => start >= link.index && start < link.index + link[0].length)) continue;
    result.push({
      kind: "session",
      label: match[2].slice(1),
      path: match[2],
      start,
      end: start + match[2].length,
      markdown: match[2],
    });
  }
  return result.sort((a, b) => a.start - b.start);
}
