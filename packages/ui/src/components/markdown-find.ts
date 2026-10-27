import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { findTextBlockTags } from "../find.ts";
import type { LinkContext } from "../link-target.ts";
import {
  markdownCodeLanguage,
  markdownPlugins,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  markdownSource,
} from "./markdown-configuration.ts";
import { shouldRenderMermaidCodeBlock } from "./mermaid-language.ts";

interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}
const blocks = new Set<string>(findTextBlockTags);
const rawText = (node: Node): string => node.value ?? node.children?.map(rawText).join("") ?? "";

/** Same Markdown syntax and sanitization as the display, without mounting rich components or effects. */
export function createMarkdownFindText(workspace: LinkContext = {}) {
  const processor = unified()
    .use(remarkParse)
    .use(markdownPlugins.cjk.remarkPluginsBefore)
    .use(markdownRemarkPlugins(workspace))
    .use(markdownPlugins.cjk.remarkPluginsAfter)
    .use([markdownPlugins.math.remarkPlugin])
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(markdownRehypePlugins ?? [])
    .use([markdownPlugins.math.rehypePlugin]);
  return (source: string): string | undefined => {
    let text = "",
      previous: Node | null = null,
      dynamic = false;
    const append = (value: string, block: Node | null) => {
      if (text && previous !== block) text += "\n";
      text += value;
      previous = block;
    };
    const visit = (node: Node, parent: Node | null): void => {
      const tag = node.tagName;
      const properties = node.properties ?? {};
      const classes = String(properties.className ?? "");
      if (
        ["button", "input", "textarea", "select", "script", "style", "img", "dialog"].includes(tag ?? "") ||
        properties.hidden ||
        /\bkatex-mathml\b/.test(classes)
      )
        return;
      if (tag === "p") {
        const children = node.children?.filter((child) => child.type !== "text" || child.value?.trim());
        // ImageParagraph renders an image-only gallery from its non-whitespace children.
        if (children?.length && children.every((child) => child.tagName === "img")) return;
      }
      const block = blocks.has(tag ?? "") ? node : parent;
      // Empty link labels can be supplied by a routing component (for example a file basename).
      if (tag === "a" && !rawText(node)) dynamic = true;
      if (node.type === "text") append(node.value ?? "", block);
      else if (tag === "pre" && node.children?.[0]?.tagName === "code") {
        const code = node.children[0];
        const language = markdownCodeLanguage(code.properties?.className);
        const value = rawText(code);
        if (shouldRenderMermaidCodeBlock(language, value)) dynamic = true;
        else {
          // MarkdownCode's language label precedes its preformatted source; toolbar buttons are ignored.
          append(language, parent);
          append(value, node);
        }
      } else {
        if (tag === "pre") dynamic = true;
        for (const child of node.children ?? []) visit(child, block);
      }
    };
    try {
      const markdown = markdownSource(source, false);
      visit(processor.runSync(processor.parse(markdown), markdown) as Node, null);
      return dynamic ? undefined : text;
    } catch {
      // Custom renderers and malformed Markdown retain the existing DOM-based search path.
      return undefined;
    }
  };
}
