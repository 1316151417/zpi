// ZCode SearchToolCallBlock semantics: a non-expandable process summary (Apache-2.0).
import { Globe, Search } from "lucide-react";
import type { ToolBlockProps } from "./ToolBlock.tsx";
import { ToolFailure } from "./ToolFailure.tsx";
import { ToolLayout } from "./ToolLayout.tsx";
import { toolInput } from "./tool-presentation.ts";
import { normalizeWebToolDetails, safeWebUrl } from "./web-tool-data.ts";

export function WebToolBlock({ block, onCopy, showIcon }: ToolBlockProps) {
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
  const primary = search ? (query ? `查找 ${query}` : "搜索网页") : url || details?.title || "读取网页";
  const message = details?.message ?? (status === "error" ? block.output.slice(0, 2000) : "");
  const outcome =
    status === "cancelled"
      ? "已取消"
      : status === "success"
        ? search && details?.results
          ? `${details.results.length} 个来源`
          : "已完成"
        : undefined;
  return (
    <div className="tool-block" data-testid="tool-block" data-tool-name={block.name}>
      <ToolLayout
        icon={search ? Search : Globe}
        label={search ? (running ? "正在搜索" : "联网搜索") : running ? "正在读取" : "读取网页"}
        running={running}
        showIcon={showIcon}
        expanded={false}
        primary={<span className="tool-summary-text">{primary}</span>}
        trailing={outcome ? <span className="tool-summary-status">{outcome}</span> : undefined}
        failure={
          status === "error" ? (
            <ToolFailure text={message || "联网工具执行失败"} onCopy={onCopy} />
          ) : undefined
        }
      />
    </div>
  );
}
