import {
  type MarkdownTheme,
  replaceControlCharacters,
  type SelectListTheme,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";

const style = (on: number | string, off: number) => (text: string) =>
  process.env.NO_COLOR === undefined ? `\x1b[${on}m${text}\x1b[${off}m` : text;
export const dim = style(2, 22);
export const accent = style("38;5;110", 39);
export const bold = style(1, 22);
export const wordmark = bold(style("38;5;179", 39)("ZPI"));
const plain = (text: string) => text;
export function safeText(raw: string) {
  return stripTerminalSequences(raw)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => replaceControlCharacters(line.replace(/\t/g, "    ")))
    .join("\n");
}
export const listTheme: SelectListTheme = {
  selectedPrefix: accent,
  selectedText: bold,
  description: dim,
  noMatch: dim,
  scrollInfo: dim,
};
export const markdownTheme: MarkdownTheme = {
  heading: bold,
  link: accent,
  linkUrl: dim,
  code: accent,
  codeBlock: plain,
  codeBlockBorder: dim,
  quote: plain,
  quoteBorder: dim,
  hr: dim,
  listBullet: dim,
  bold,
  italic: style(3, 23),
  strikethrough: style(9, 29),
  underline: style(4, 24),
};
