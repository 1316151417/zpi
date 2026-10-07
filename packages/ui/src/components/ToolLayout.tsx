// Adapted from ZCode ToolLayout/ToolSummaryRow and collapsible.tsx (Apache-2.0).
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { QueuedSummaryContent } from "./QueuedSummaryContent.tsx";

export function ToolLayout({
  icon: Icon,
  label,
  running,
  showIcon = true,
  expanded,
  toggle,
  content,
  primary,
  secondary,
  trailing,
  failure,
  separator,
  contentKey,
  animate = false,
  title,
  prioritize = false,
}: {
  icon: LucideIcon;
  label: string;
  running: boolean;
  showIcon?: boolean;
  expanded: boolean;
  toggle?: () => void;
  content?: ReactNode;
  primary?: ReactNode;
  secondary?: ReactNode;
  trailing?: ReactNode;
  failure?: ReactNode;
  separator?: string;
  contentKey?: string;
  animate?: boolean;
  title?: string;
  prioritize?: boolean;
}) {
  const [renderContent, setRenderContent] = useState(expanded);
  useEffect(() => {
    if (expanded) {
      setRenderContent(true);
      return;
    }
    if (!renderContent) return;
    // ZCode 的关闭动画须保留真实高度，300ms 后再卸载详情。
    const timer = setTimeout(() => setRenderContent(false), 300);
    return () => clearTimeout(timer);
  }, [expanded, renderContent]);
  const summaryContent = (
    <>
      {showIcon && <Icon size={16} aria-hidden="true" className="process-icon" />}
      <strong className={`tool-kind-label${running ? " thinking-label-streaming" : ""}`}>{label}</strong>
      {(primary || secondary || trailing || failure) && (
        <div className="tool-summary-content">
          {separator && <span className="process-separator">{separator}</span>}
          <QueuedSummaryContent
            contentKey={contentKey ?? "summary"}
            primaryText={primary}
            secondaryText={secondary}
            trailingText={trailing}
            enabled={animate && !expanded}
          />
          {failure}
        </div>
      )}
      {toggle && (
        <ChevronRight
          size={16}
          aria-hidden="true"
          className={`process-chevron ${expanded ? "rotated" : ""}`}
        />
      )}
    </>
  );
  const summaryClass = `tool-summary-row ${toggle ? "tool-title" : "tool-summary-static"}${prioritize ? " tool-prioritize-file" : ""}`;
  const summary = toggle ? (
    // biome-ignore lint/a11y/useSemanticElements: File buttons inside the summary must not nest within a button.
    <div
      className={summaryClass}
      data-testid="tool-summary"
      title={title}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={expanded ? "收起工具详情" : "展开工具详情"}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        toggle();
      }}
    >
      {summaryContent}
    </div>
  ) : (
    <div className={summaryClass} data-testid="tool-summary" title={title}>
      {summaryContent}
    </div>
  );
  return (
    <Collapsible.Root open={expanded} className="tool-layout">
      {summary}
      {toggle && (
        <Collapsible.Content className="tool-content-shell">
          <div className="tool-content-fade">
            <div className="tool-content-spacing">{expanded || renderContent ? content : null}</div>
          </div>
        </Collapsible.Content>
      )}
    </Collapsible.Root>
  );
}
