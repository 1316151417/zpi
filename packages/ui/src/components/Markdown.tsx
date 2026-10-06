import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import type { ComponentProps, ReactNode } from "react";
import { Children, Component, isValidElement, memo, useMemo } from "react";
import rehypeSanitize from "rehype-sanitize";
import type { ExtraProps, StreamdownProps } from "streamdown";
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown, useIsCodeFenceIncomplete } from "streamdown";
import { fileCitationRemarkPlugin, projectFileCitations } from "../file-citation.ts";
import { type FileLocation, resolveLinkTarget, type WebOpenOptions } from "../link-target.ts";
import { type MarkdownFence, markdownFence } from "../markdown-fence.ts";
import { markdownLinkRemarkPlugin } from "../markdown-link-nodes.ts";
import type { FileActionHandler } from "../types.ts";
import { MarkdownContext, type MarkdownServices } from "./MarkdownActions.tsx";
import { MarkdownCode } from "./MarkdownCode.tsx";
import { MarkdownImage } from "./MarkdownImage.tsx";
import { MarkdownLink } from "./MarkdownLink.tsx";
import { MarkdownTable } from "./MarkdownTable.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";
import { normalizeMath } from "./markdown-math.ts";
import { shouldRenderMermaidCodeBlock } from "./mermaid-language.ts";
import { Reference } from "./Reference.tsx";

type Plugin = NonNullable<StreamdownProps["remarkPlugins"]>[number];
const noSingleTilde = (plugin: Plugin): Plugin => {
  const [attach, options] = Array.isArray(plugin) ? plugin : [plugin, {}];
  if (typeof attach !== "function") return plugin;
  return [attach, { ...(typeof options === "object" ? options : {}), singleTilde: false }];
};
const after = cjk.remarkPluginsAfter.map(noSingleTilde);
const plugins = {
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
        const target = node.properties.dataZPITarget ?? (key ? node.properties[key] : undefined);
        if (key && typeof target === "string") {
          node.properties.dataZPITarget = target;
          // Keep the original destination before sanitizer/harden normalize local paths.
          if (!/^https?:/i.test(target) && !(key === "src" && /^data:image\//i.test(target)))
            node.properties[key] = "/ZPI-local-target";
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
const rehypePlugins: StreamdownProps["rehypePlugins"] = [
  defaultRehypePlugins.raw,
  preserveTargets,
  [
    rehypeSanitize,
    {
      ...sanitizeSchema,
      attributes: {
        ...sanitizeSchema.attributes,
        a: [...(sanitizeSchema.attributes?.a ?? []), "dataZPITarget"],
        img: [...(sanitizeSchema.attributes?.img ?? []), "dataZPITarget"],
      },
    },
  ],
  defaultRehypePlugins.harden,
];
function rawText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(rawText).join("");
  if (isValidElement<{ children?: unknown }>(value)) return rawText(value.props.children);
  return "";
}
function RenderCode(props: ComponentProps<"code"> & ExtraProps) {
  const incomplete = useIsCodeFenceIncomplete();
  const language = /language-([^\s]+)/.exec(props.className ?? "")?.[1]?.toLowerCase() ?? "text";
  if (!("data-block" in props)) {
    const { node: _node, className: _className, ...codeProps } = props;
    return <code {...codeProps} className="markdown-inline-code" />;
  }
  const source = rawText(props.children);
  if (shouldRenderMermaidCodeBlock(language, source))
    return incomplete ? (
      <div data-streamdown="mermaid-block" className="mermaid-pending" role="status">
        图表生成中…
      </div>
    ) : (
      <MermaidBlock code={source} />
    );
  return <MarkdownCode source={source} language={language} incomplete={incomplete} />;
}

function ImageParagraph({ children, node: _node, ...props }: ComponentProps<"p"> & ExtraProps) {
  const elements = Children.toArray(children).filter((child) => typeof child !== "string" || child.trim());
  const images =
    elements.length > 0 &&
    elements.every(
      (child) =>
        isValidElement<{ node?: { tagName?: string } }>(child) && child.props.node?.tagName === "img",
    );
  return images ? (
    <div className={elements.length > 1 ? "markdown-image-gallery" : "markdown-image-single"}>{elements}</div>
  ) : (
    <p {...props}>{children}</p>
  );
}

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

class MarkdownBoundary extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(previous: Readonly<{ text: string; children: ReactNode }>) {
    if (this.state.failed && previous.text !== this.props.text) this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? (
      <div className="markdown-fallback">{this.props.text}</div>
    ) : (
      this.props.children
    );
  }
}

export const Markdown = memo(function Markdown({
  text,
  streaming,
  workspace,
  onLink,
  onCopy,
  onFile,
  onFileAction,
  onImage,
  onDownloadImage,
}: MarkdownServices & {
  text: string;
  onLink: (url: string, options?: WebOpenOptions) => void;
  onFile?: (path: string, location?: FileLocation) => void;
  onFileAction?: FileActionHandler;
}) {
  const components = useMemo<NonNullable<StreamdownProps["components"]>>(
    () => ({
      a: ({ href, children, node }) => {
        const original = node?.properties?.dataZPITarget;
        const destination = typeof original === "string" ? original : href;
        const target = destination ? resolveLinkTarget(destination, workspace) : null;
        if (target?.kind === "file" && onFile) {
          const { kind: _kind, path, ...location } = target;
          return (
            <Reference
              kind="file"
              className="message-file-link"
              path={path}
              label={rawText(children) || path.split("/").at(-1) || path}
              onOpen={() => onFile(path, location)}
              onAction={onFileAction ? (path, action) => onFileAction(path, action, location) : undefined}
            />
          );
        }
        if (target?.kind !== "web") return <span>{children}</span>;
        return (
          <MarkdownLink url={target.url} onOpen={onLink}>
            {children}
          </MarkdownLink>
        );
      },
      strong: ({ node: _node, className: _className, ...props }) => <strong {...props} />,
      code: RenderCode,
      table: MarkdownTable,
      p: ImageParagraph,
      img: MarkdownImage,
    }),
    [onLink, onFile, onFileAction, workspace],
  );
  const markdown = useMemo(
    () => normalizeMath(groupImages(projectFileCitations(text, streaming))),
    [text, streaming],
  );
  const remarks = useMemo(
    () => [...remarkPlugins, fileCitationRemarkPlugin(workspace ?? {}), markdownLinkRemarkPlugin],
    [workspace],
  );
  return (
    <MarkdownContext.Provider value={{ streaming, workspace, onCopy, onImage, onDownloadImage }}>
      <MarkdownBoundary text={text}>
        <Streamdown
          className="markdown-body"
          mode={streaming ? "streaming" : "static"}
          parseIncompleteMarkdown={streaming}
          skipHtml
          components={components}
          plugins={plugins}
          rehypePlugins={rehypePlugins}
          remarkPlugins={remarks}
          shikiTheme={["github-light", "github-dark"]}
          animated={false}
          isAnimating={streaming}
          controls={{ code: false, mermaid: false, table: false, image: false }}
        >
          {markdown}
        </Streamdown>
      </MarkdownBoundary>
    </MarkdownContext.Provider>
  );
});
