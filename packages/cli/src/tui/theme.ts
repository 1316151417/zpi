import { createRequire } from "node:module";
import {
  type MarkdownTheme,
  replaceControlCharacters,
  type SelectListTheme,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";

const style = (on: number | string, off: number) => (text: string) =>
  process.env.NO_COLOR === undefined ? `\x1b[${on}m${text}\x1b[${off}m` : text;
export const dim = style("38;2;128;128;128", 39);
export const accent = style("38;2;202;126;204", 39);
export const bold = style(1, 22);
export const wordmark = bold(style("38;2;242;190;87", 39)("ZPI"));
export const italic = style(3, 23);
export const suggestion = style("38;2;177;185;249", 39);
export const success = style("38;2;111;178;105", 39);
export const failure = style("38;2;226;125;119", 39);
export const foreground = style("38;2;220;220;220", 39);
export const muted = style("38;2;158;158;158", 39);
const neutralBorder = style("38;2;109;109;109", 39);
const thinkingBorders = new Map([
  ["minimal", style("38;2;64;98;241", 39)],
  ["low", style("38;2;71;107;244", 39)],
  ["medium", style("38;2;57;144;147", 39)],
  ["high", style("38;2;188;90;192", 39)],
  ["xhigh", style("38;2;211;71;212", 39)],
  ["max", style("38;2;232;98;95", 39)],
]);
export function thinkingBorderColor(level = "off") {
  return thinkingBorders.get(level) ?? neutralBorder;
}
export const thinking = style("38;2;151;151;151", 39);
export const userBackground = style("48;2;33;44;79", 49);
export const toolBackground = {
  pending: style("48;2;46;46;46", 49),
  success: style("48;2;34;51;32", 49),
  error: style("48;2;66;37;35", 49),
};
export const resourceTitle = style("38;2;170;163;38", 39);
export function safeText(raw: string) {
  return stripTerminalSequences(raw)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => replaceControlCharacters(line.replace(/\t/g, "    ")))
    .join("\n");
}
export const panelBorder = {
  render: (width: number) => [dim("─".repeat(width))],
  invalidate() {},
};

export const listTheme: SelectListTheme = {
  selectedPrefix: accent,
  selectedText: accent,
  description: dim,
  noMatch: dim,
  scrollInfo: dim,
};
const blue = style("38;2;120;153;249", 39);
const teal = style("38;2;104;172;174", 39);
const underline = style(4, 24);
const syntax = {
  keyword: blue,
  built_in: accent,
  literal: success,
  number: style("38;2;200;128;202", 39),
  regexp: success,
  string: success,
  subst: foreground,
  comment: muted,
  doctag: muted,
  meta: muted,
  function: resourceTitle,
  title: resourceTitle,
  class: accent,
  type: accent,
  tag: muted,
  name: blue,
  attr: teal,
  variable: teal,
  params: teal,
  operator: muted,
  punctuation: muted,
  emphasis: italic,
  strong: bold,
  link: underline,
  addition: success,
  deletion: failure,
};
let highlighter: typeof import("cli-highlight") | undefined;
export const markdownTheme: MarkdownTheme = {
  heading: resourceTitle,
  link: blue,
  linkUrl: muted,
  code: accent,
  codeBlock: success,
  codeBlockBorder: muted,
  quote: muted,
  quoteBorder: muted,
  hr: muted,
  listBullet: accent,
  bold,
  italic,
  strikethrough: style(9, 29),
  underline,
  highlightCode(code, language) {
    if (language && process.env.NO_COLOR === undefined && code.length <= 16_384) {
      highlighter ??= createRequire(import.meta.url)("cli-highlight") as typeof import("cli-highlight");
      if (highlighter.supportsLanguage(language)) {
        try {
          return highlighter.highlight(code, { language, theme: syntax, ignoreIllegals: true }).split("\n");
        } catch {
          // A malformed snippet still renders as ordinary fenced code.
        }
      }
    }
    return code.split("\n").map(success);
  },
};
