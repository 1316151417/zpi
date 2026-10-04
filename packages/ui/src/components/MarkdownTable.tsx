import { ArrowLeftFromLine, ArrowRightToLine, Download, Maximize2 } from "lucide-react";
import type { ComponentProps, CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import type { ExtraProps } from "streamdown";
import { downloadBlob, MarkdownCopy, MarkdownPreview } from "./MarkdownActions.tsx";
import { tableCsv, tableMarkdown } from "./markdown-table-text.ts";

export function MarkdownTable({ children, node: _node, ...props }: ComponentProps<"table"> & ExtraProps) {
  const table = useRef<HTMLTableElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [metrics, setMetrics] = useState({ left: 0, max: 0, width: 0, extra: 0, thumb: 48 });
  const measure = () => {
    const element = viewport.current;
    const root = frame.current;
    if (!element || !root) return;
    const bounds = root.getBoundingClientRect();
    const container = root.closest(".conversation, .file-pane-content")?.getBoundingClientRect();
    const extra = container ? Math.max(0, container.right - bounds.right - 16) : 0;
    const next = {
      left: element.scrollLeft,
      max: Math.max(0, element.scrollWidth - element.clientWidth),
      width: bounds.width,
      extra,
      thumb: Math.max(48, element.clientWidth ** 2 / Math.max(1, element.scrollWidth)),
    };
    setMetrics((old) =>
      Object.keys(next).every((key) => old[key as keyof typeof old] === next[key as keyof typeof next])
        ? old
        : next,
    );
  };
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    if (table.current) observer.observe(table.current);
    if (viewport.current) observer.observe(viewport.current);
    if (frame.current) observer.observe(frame.current);
    const container = frame.current?.closest(".conversation, .file-pane-content");
    if (container) observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const rows = () =>
    Array.from(table.current?.rows ?? [], (row) =>
      Array.from(row.cells, (cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()),
    );
  const scroll = (left: number) => {
    if (viewport.current) viewport.current.scrollLeft = left;
  };
  const tableProps = { ...props, className: "markdown-table", children };
  return (
    <div className="markdown-table-block">
      <div className="markdown-toolbar" data-markdown-table-toolbar="">
        <MarkdownCopy
          text={() => tableMarkdown(rows())}
          label="复制 Markdown"
          success="已复制 Markdown 表格"
        />
        <button
          type="button"
          className="markdown-action"
          aria-label="下载 CSV"
          title="下载 CSV"
          onClick={() =>
            downloadBlob(new Blob([tableCsv(rows())], { type: "text/csv;charset=utf-8" }), "table.csv")
          }
        >
          <Download size={14} />
        </button>
        <button
          type="button"
          className="markdown-action"
          aria-label="预览表格"
          title="预览表格"
          onClick={() => setPreview(true)}
        >
          <Maximize2 size={14} />
        </button>
        {metrics.extra > 1 && (metrics.max > 1 || expanded) && (
          <button
            type="button"
            className="markdown-action"
            aria-label={expanded ? "收回表格滚动区域" : "展开表格滚动区域"}
            title={expanded ? "收回表格滚动区域" : "展开表格滚动区域"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ArrowLeftFromLine size={14} /> : <ArrowRightToLine size={14} />}
          </button>
        )}
      </div>
      <div ref={frame} className="markdown-table-frame" data-markdown-table-frame="">
        <div
          className="markdown-table-border"
          style={expanded ? { width: metrics.width + metrics.extra } : undefined}
        >
          <div ref={viewport} className="markdown-table-scroll" onScroll={measure}>
            <table ref={table} {...tableProps} data-streamdown="table" />
          </div>
          {metrics.left > 1 && (
            <div
              aria-hidden="true"
              className="markdown-table-shadow left"
              data-markdown-table-edge-shadow="left"
            />
          )}
          {metrics.max - metrics.left > 1 && (
            <div
              aria-hidden="true"
              className="markdown-table-shadow right"
              data-markdown-table-edge-shadow="right"
            />
          )}
        </div>
        {metrics.max > 1 && (
          <div
            className="markdown-table-scrollbar"
            style={
              {
                width: expanded ? metrics.width + metrics.extra : undefined,
                "--markdown-table-thumb-width": `${metrics.thumb}px`,
              } as CSSProperties
            }
          >
            <input
              type="range"
              aria-label="表格横向滚动"
              min={0}
              max={metrics.max}
              value={metrics.left}
              onChange={(event) => scroll(Number(event.target.value))}
              onWheel={(event) => {
                const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
                if (delta) scroll(metrics.left + delta);
              }}
            />
          </div>
        )}
      </div>
      {preview && (
        <MarkdownPreview
          title="表格预览"
          description="在更大的可滚动视图中查看表格。"
          onClose={() => setPreview(false)}
        >
          <div className="markdown-table-preview-scroll">
            <table {...tableProps} data-streamdown="table-preview" />
          </div>
        </MarkdownPreview>
      )}
    </div>
  );
}
