import { Globe, Search } from "lucide-react";
import type { ReactNode } from "react";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Streamdown, type StreamdownProps } from "streamdown";
import type { WebOpenOptions } from "../link-target.ts";
import { MarkdownLink } from "./MarkdownLink.tsx";
import type { ToolBlockProps } from "./ToolBlock.tsx";
import { ToolFailure } from "./ToolFailure.tsx";
import { ToolLayout } from "./ToolLayout.tsx";
import { toolInput } from "./tool-presentation.ts";
import { normalizeWebToolDetails, safeWebUrl, webToolLimits } from "./web-tool-data.ts";
import "./web-tool-block.css";

type WebLinkHandler = NonNullable<ToolBlockProps["onLink"]>;

export function openWebToolLink(value: unknown, onLink?: WebLinkHandler, options?: WebOpenOptions) {
  const url = safeWebUrl(value);
  if (url) onLink?.(url, options);
}

function WebToolLink({
  url,
  children,
  onLink,
}: {
  url: string;
  children: ReactNode;
  onLink?: WebLinkHandler;
}) {
  const destination = safeWebUrl(url);
  return destination && onLink ? (
    <MarkdownLink url={destination} onOpen={(value, options) => openWebToolLink(value, onLink, options)}>
      {children}
    </MarkdownLink>
  ) : (
    <span>{children}</span>
  );
}

// Do not reuse the conversation renderer: it supports local files, remote images and diagrams.
const webRehypePlugins: StreamdownProps["rehypePlugins"] = [
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      attributes: { ...defaultSchema.attributes, a: ["href", "title"], img: ["alt"] },
      protocols: { ...defaultSchema.protocols, href: ["http", "https"], src: [] },
    },
  ],
];

export function WebToolMarkdown({ text, onLink }: { text: string; onLink?: WebLinkHandler }) {
  return (
    <Streamdown
      className="markdown-body web-tool-markdown"
      mode="static"
      skipHtml
      parseIncompleteMarkdown={false}
      rehypePlugins={webRehypePlugins}
      urlTransform={(url) => safeWebUrl(url) ?? ""}
      controls={{ code: false, mermaid: false, table: false, image: false }}
      components={{
        a: ({ href, children }) => (
          <WebToolLink url={href ?? ""} onLink={onLink}>
            {children}
          </WebToolLink>
        ),
        img: ({ alt }) => <span className="web-image-placeholder">[图片未加载{alt ? `：${alt}` : ""}]</span>,
        code: ({ children }) => <code>{children}</code>,
        pre: ({ children }) => <pre>{children}</pre>,
      }}
    >
      {text.slice(0, webToolLimits.content)}
    </Streamdown>
  );
}

export function WebToolBlock({ block, expanded, toggle, onLink, onCopy, showIcon }: ToolBlockProps) {
  const details = normalizeWebToolDetails(block.web, block.name);
  const input = toolInput(block);
  const search = block.name === "web_search";
  const status =
    details?.status ??
    (block.status === "preparing" || block.status === "running"
      ? "pending"
      : block.status === "error"
        ? "error"
        : "success");
  const running = status === "pending";
  const query = details?.query ?? (typeof input.query === "string" ? input.query.slice(0, 2000) : "");
  const url = details?.url ?? safeWebUrl(input.url);
  const sources = details?.results ?? [];
  const message = details?.message ?? (status === "error" ? block.output.slice(0, 2000) : "");
  const outcome =
    status === "cancelled"
      ? "已取消"
      : status === "pending"
        ? "进行中"
        : status === "success"
          ? search
            ? details?.results
              ? `${sources.length} 个来源`
              : "已完成"
            : "已读取"
          : undefined;
  return (
    <div className="tool-block web-tool-block" data-testid="tool-block" data-tool-name={block.name}>
      <ToolLayout
        icon={search ? Search : Globe}
        label={search ? "联网搜索" : "读取网页"}
        running={running}
        showIcon={showIcon}
        expanded={expanded}
        toggle={toggle}
        primary={
          <span className="tool-summary-text">
            {search ? query || "准备搜索" : details?.title || url || "准备读取"}
          </span>
        }
        trailing={outcome ? <span className="tool-summary-status">{outcome}</span> : undefined}
        failure={
          status === "error" ? (
            <ToolFailure text={message || "联网工具执行失败"} onCopy={onCopy} />
          ) : undefined
        }
        content={
          <div className="web-tool-details" data-conversation-selectable="tool" data-selection-key={block.id}>
            {message && <p className={status === "error" ? "web-tool-error" : "web-tool-note"}>{message}</p>}
            {search ? (
              <>
                {query && <p className="web-tool-query">{query}</p>}
                {!!sources.length && (
                  <ol className="web-source-list">
                    {sources.map((source, index) => (
                      <li className="web-source" key={`${index}:${source.url}`}>
                        <div className="web-source-heading">
                          <span
                            className="web-source-icon"
                            title="网站图标未加载"
                            role="img"
                            aria-label="网站图标占位"
                          >
                            <Globe size={16} aria-hidden="true" />
                          </span>
                          <div className="web-source-identity">
                            <WebToolLink url={source.url} onLink={onLink}>
                              {source.title || source.site_name || new URL(source.url).hostname}
                            </WebToolLink>
                            <span className="web-source-url">{source.url}</span>
                          </div>
                        </div>
                        {(source.site_name || source.date) && (
                          <div className="web-source-meta">
                            {source.site_name && <span>{source.site_name}</span>}
                            {source.date && <span>{source.date}</span>}
                          </div>
                        )}
                        {source.snippet && <p>{source.snippet}</p>}
                        {source.summary && source.summary !== source.snippet && <p>{source.summary}</p>}
                      </li>
                    ))}
                  </ol>
                )}
                {details?.results && !sources.length && status === "success" && (
                  <p className="web-tool-note">未找到搜索结果。</p>
                )}
              </>
            ) : (
              <>
                {url && (
                  <p className="web-fetch-url">
                    <WebToolLink url={url} onLink={onLink}>
                      {url}
                    </WebToolLink>
                  </p>
                )}
                {details?.title && <h4 className="web-fetch-title">{details.title}</h4>}
                {details?.content ? (
                  <WebToolMarkdown text={details.content} onLink={onLink} />
                ) : details && status === "success" ? (
                  <p className="web-tool-note">网页未返回可显示的正文。</p>
                ) : null}
              </>
            )}
            {!details && status === "success" && block.output && (
              <pre className="web-tool-legacy">{block.output.slice(0, webToolLimits.content)}</pre>
            )}
            {running && (
              <p className="web-tool-note" role="status">
                {search ? "正在搜索…" : "正在读取网页…"}
              </p>
            )}
            {details?.truncated && <p className="web-tool-note">内容较长，已截断显示。</p>}
          </div>
        }
      />
    </div>
  );
}
