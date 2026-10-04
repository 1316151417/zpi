export interface Mention {
  kind: "file" | "skill";
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
export function parseMentions(text: string): Mention[] {
  const result: Mention[] = [];
  for (const match of text.matchAll(pattern)) {
    const label = unescapeMarkdown(match[1]),
      path = unescapeMarkdown(match[2] ?? match[3]);
    if (!path.startsWith("/") && !path.startsWith("./") && !path.startsWith("../")) continue;
    result.push({
      kind: label.startsWith("$") ? "skill" : "file",
      label: label.replace(/^[$@]/, ""),
      path,
      start: match.index,
      end: match.index + match[0].length,
      markdown: match[0],
    });
  }
  return result;
}
