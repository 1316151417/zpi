import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import rehypeSanitize from "rehype-sanitize";
import { defaultRehypePlugins, defaultRemarkPlugins, type StreamdownProps } from "streamdown";
import { fileCitationRemarkPlugin, projectFileCitations } from "../file-citation.ts";
import type { LinkContext } from "../link-target.ts";
import { type MarkdownFence, markdownFence } from "../markdown-fence.ts";
import { markdownLinkRemarkPlugin } from "../markdown-link-nodes.ts";
import { normalizeMath } from "./markdown-math.ts";

type Plugin = NonNullable<StreamdownProps["remarkPlugins"]>[number];
const noSingleTilde = (plugin: Plugin): Plugin => {
  const [attach, options] = Array.isArray(plugin) ? plugin : [plugin, {}];
  if (typeof attach !== "function") return plugin;
  return [attach, { ...(typeof options === "object" ? options : {}), singleTilde: false }];
};
const after = cjk.remarkPluginsAfter.map(noSingleTilde);
export const markdownPlugins = {
  code,
  math: createMathPlugin({ singleDollarTextMath: true }),
  cjk: { ...cjk, remarkPlugins: [...cjk.remarkPluginsBefore, ...after], remarkPluginsAfter: after },
};
const remarkPlugins = Object.entries(defaultRemarkPlugins).map(([name, plugin]) =>
  name === "gfm" ? noSingleTilde(plugin) : plugin,
);
type Schema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;
const sanitizeSchema = (defaultRehypePlugins.sanitize as [unknown, Schema])[1];
interface MarkdownNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
}
function preserveTargets() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.properties) {
        const key = node.tagName === "a" ? "href" : node.tagName === "img" ? "src" : undefined;
        const target = node.properties.dataZpiTarget ?? (key ? node.properties[key] : undefined);
        if (key && typeof target === "string") {
          node.properties.dataZpiTarget = target;
          // Keep the original destination before sanitizer/harden normalize local paths.
          if (!/^https?:/i.test(target) && !(key === "src" && /^data:image\//i.test(target)))
            node.properties[key] = "/zpi-local-target";
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
export const markdownRehypePlugins: StreamdownProps["rehypePlugins"] = [
  defaultRehypePlugins.raw,
  preserveTargets,
  [
    rehypeSanitize,
    {
      ...sanitizeSchema,
      attributes: {
        ...sanitizeSchema.attributes,
        a: [...(sanitizeSchema.attributes?.a ?? []), "dataZpiTarget"],
        img: [...(sanitizeSchema.attributes?.img ?? []), "dataZpiTarget"],
      },
    },
  ],
  defaultRehypePlugins.harden,
];
// Keep consecutive image-only paragraphs together, without touching code examples.
function groupImages(text: string): string {
  const lines = text.split("\n");
  const grouped: string[] = [];
  let fence: MarkdownFence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = markdownFence(line, fence);
    if (marker) fence = fence ? null : marker;
    grouped.push(line);
    if (!fence && /^\s*!\[[^\]]*]\([^\n]+\)\s*$/.test(line)) {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      if (/^\s*!\[[^\]]*]\([^\n]+\)\s*$/.test(lines[next] ?? "")) i = next - 1;
    }
  }
  return grouped.join("\n");
}

export function markdownRemarkPlugins(workspace: LinkContext = {}) {
  return [...remarkPlugins, fileCitationRemarkPlugin(workspace), markdownLinkRemarkPlugin];
}
export function markdownSource(text: string, streaming: boolean) {
  return normalizeMath(groupImages(projectFileCitations(text, streaming)));
}

export function markdownCodeLanguage(className: unknown): string {
  const classes = Array.isArray(className)
    ? className.join(" ")
    : typeof className === "string"
      ? className
      : "";
  return /language-([^\s]+)/.exec(classes)?.[1]?.toLowerCase() ?? "text";
}
