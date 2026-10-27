import type { ComponentProps, ReactNode } from "react";
import { Children, Component, isValidElement, memo, useMemo } from "react";
import type { ExtraProps, StreamdownProps } from "streamdown";
import { Streamdown, useIsCodeFenceIncomplete } from "streamdown";
import { resolveMarkdownLinkTarget, type WebOpenOptions } from "../link-target.ts";
import { MarkdownContext, type MarkdownServices, useMarkdown } from "./MarkdownActions.tsx";
import { MarkdownCode } from "./MarkdownCode.tsx";
import { MarkdownImage } from "./MarkdownImage.tsx";
import { MarkdownLink } from "./MarkdownLink.tsx";
import { MarkdownTable } from "./MarkdownTable.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";
import {
  markdownCodeLanguage,
  markdownPlugins,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  markdownSource,
} from "./markdown-configuration.ts";
import { shouldRenderMermaidCodeBlock } from "./mermaid-language.ts";
import { Reference } from "./Reference.tsx";

function rawText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(rawText).join("");
  if (isValidElement<{ children?: unknown }>(value)) return rawText(value.props.children);
  return "";
}
function RenderCode(props: ComponentProps<"code"> & ExtraProps) {
  const incomplete = useIsCodeFenceIncomplete();
  const language = markdownCodeLanguage(props.className);
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

function RenderLink({ href, children, node }: ComponentProps<"a"> & ExtraProps) {
  const { workspace, onLink, onFile, onFileAction } = useMarkdown();
  const original = node?.properties?.dataZpiTarget;
  const destination = typeof original === "string" ? original : href;
  const target = destination ? resolveMarkdownLinkTarget(destination, workspace) : null;
  if (target?.kind === "file" && onFile) {
    const { kind: _kind, path, ...location } = target;
    return (
      <Reference
        kind="file"
        className="message-file-link"
        path={path}
        label={rawText(children) || path.split("/").at(-1) || path}
        onOpen={() => onFile(path, location, "markdown-link")}
        onAction={onFileAction ? (path, action) => onFileAction(path, action, location) : undefined}
      />
    );
  }
  if (target?.kind !== "web" || !onLink) return <span>{children}</span>;
  return (
    <MarkdownLink url={target.url} onOpen={onLink}>
      {children}
    </MarkdownLink>
  );
}

// Stable component types preserve native selection anchors when routing callbacks change.
const components: NonNullable<StreamdownProps["components"]> = {
  a: RenderLink,
  strong: ({ node: _node, className: _className, ...props }) => <strong {...props} />,
  code: RenderCode,
  table: MarkdownTable,
  p: ImageParagraph,
  img: MarkdownImage,
};

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
      <div className="markdown-fallback" data-find-rendered>
        {this.props.text}
      </div>
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
}) {
  const markdown = useMemo(() => markdownSource(text, streaming), [text, streaming]);
  const remarks = useMemo(() => markdownRemarkPlugins(workspace), [workspace]);
  return (
    <MarkdownContext.Provider
      value={{ streaming, workspace, onLink, onFile, onFileAction, onCopy, onImage, onDownloadImage }}
    >
      <MarkdownBoundary text={text}>
        <Streamdown
          className="markdown-body"
          mode={streaming ? "streaming" : "static"}
          parseIncompleteMarkdown={streaming}
          skipHtml
          components={components}
          plugins={markdownPlugins}
          rehypePlugins={markdownRehypePlugins}
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
