// Preview behavior adapted from ZCode (Apache-2.0), with ZPI host/context integration.
import { ChevronLeft, ChevronRight, FileDown, MousePointer2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { logRendererError } from "./error-log.ts";
import { openWebLink, paneTask } from "./pane-store.ts";
import { clampPresentationPageNumber, clampPresentationZoomPercent } from "./presentation/controls.ts";
import { hitTestPresentationElement } from "./presentation/element-model.ts";
import { exportPresentationPdf } from "./presentation/export.ts";
import { createPresentationSelection } from "./presentation/reference.ts";
import type { PresentationPageElement, PresentationPreviewDocument } from "./presentation/types.ts";
import { addConversationSelection, unwrap } from "./store.ts";
import "./PptxPreview.css";

function useSize(node: HTMLElement | null) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!node) return;
    const update = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return size;
}

import { safePresentationUrl } from "./presentation/controls.ts";

function Slide({
  document: presentation,
  index,
  scale,
  onNavigate,
  onLink,
  onError,
}: {
  document: PresentationPreviewDocument;
  index: number;
  scale: number;
  onNavigate?: (index: number) => void;
  onLink?: (url: string) => void;
  onError?: (error: unknown) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onNavigate, onLink, onError });
  callbacks.current = { onNavigate, onLink, onError };
  useEffect(() => {
    const container = mount.current;
    if (!container) return;
    let active = true;
    let handle: ReturnType<PresentationPreviewDocument["renderPage"]> | undefined;
    // Renderer links must never navigate the Electron renderer itself.
    const click = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href") ?? "";
      if (href.startsWith("#")) return;
      event.preventDefault();
      event.stopPropagation();
      const url = safePresentationUrl(href);
      if (url) callbacks.current.onLink?.(url);
    };
    container.addEventListener("click", click, true);
    try {
      handle = presentation.renderPage(index, container, {
        onNavigate: ({ pageIndex, url }) => {
          if (pageIndex !== undefined) callbacks.current.onNavigate?.(pageIndex);
          else if (url && safePresentationUrl(url)) callbacks.current.onLink?.(url);
        },
        onNodeError: (_id, error) => logRendererError("pptx-node", error),
      });
      void handle.ready.catch((error: unknown) => {
        if (active) callbacks.current.onError?.(error);
      });
    } catch (error) {
      callbacks.current.onError?.(error);
    }
    return () => {
      active = false;
      container.removeEventListener("click", click, true);
      handle?.dispose();
    };
  }, [presentation, index]);
  return (
    <div
      className="pptx-slide"
      style={{ width: presentation.pageSize.width * scale, height: presentation.pageSize.height * scale }}
    >
      <div
        ref={mount}
        className="pptx-slide-mount"
        style={{
          width: presentation.pageSize.width,
          height: presentation.pageSize.height,
          transform: `scale(${scale})`,
        }}
      />
    </div>
  );
}

function Thumbnail({
  document: presentation,
  index,
  selected,
  onSelect,
  root,
}: {
  document: PresentationPreviewDocument;
  index: number;
  selected: boolean;
  onSelect: () => void;
  root: HTMLElement | null;
}) {
  const [node, setNode] = useState<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);
  const size = useSize(node);
  useEffect(() => {
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false), {
      root,
      rootMargin: "200px 0px",
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, root]);
  useEffect(() => {
    if (selected) node?.scrollIntoView({ block: "nearest" });
  }, [selected, node]);
  const scale = Math.max(0, size.width - 16) / presentation.pageSize.width;
  return (
    <button
      type="button"
      ref={setNode}
      className="pptx-thumbnail"
      aria-current={selected ? "page" : undefined}
      aria-label={`第 ${index + 1} 页`}
      onClick={onSelect}
    >
      <span
        className="pptx-thumbnail-canvas"
        style={{ aspectRatio: `${presentation.pageSize.width} / ${presentation.pageSize.height}` }}
      >
        {visible && scale > 0 ? <Slide document={presentation} index={index} scale={scale} /> : null}
      </span>
      <span>{index + 1}</span>
    </button>
  );
}

export interface PptxPreviewProps {
  preview: { path: string; bytes: Uint8Array };
  sessionId: string;
  onExportPdf?: (document: PresentationPreviewDocument, fileName: string) => Promise<void>;
}

export default function PptxPreview({ preview, sessionId, onExportPdf }: PptxPreviewProps) {
  const [presentation, setPresentation] = useState<PresentationPreviewDocument | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [zoom, setZoom] = useState(100);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [thumbnails, setThumbnails] = useState<HTMLElement | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<PresentationPageElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [selectedText, setSelectedText] = useState("");
  const [exporting, setExporting] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const [actionPosition, setActionPosition] = useState({ left: 0, top: 0, visible: false });
  const generation = useRef(0);
  const [addingReference, setAddingReference] = useState(false);
  const size = useSize(viewport);
  const commentInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) commentInput.current?.focus();
  }, [editing]);
  const exportPdf =
    onExportPdf ??
    (async (document: PresentationPreviewDocument, fileName: string) => {
      const { renderPresentationToPrintHost } = await import("./presentation/print-export.ts");
      await exportPresentationPdf({
        document,
        fileName,
        prepare: (document) => renderPresentationToPrintHost(document, window.document, sessionId),
        print: async () => unwrap(await window.zpi.printPageToPdf(sessionId)),
        save: async (bytes, name) => unwrap(await window.zpi.savePreviewPdf(bytes, name)),
      });
    });
  useEffect(() => {
    generation.current += 1;
    let active = true;
    let document: PresentationPreviewDocument | undefined;
    setPresentation(null);
    setAddingReference(false);
    setError("");
    setPage(1);
    setPageInput("1");
    setZoom(100);
    setSelectionMode(false);
    setSelected(null);
    setSelectedText("");
    setEditing(false);
    setComment("");
    void import("./presentation/pptx-engine.ts")
      .then(({ pptxRendererPreviewEngine }) =>
        pptxRendererPreviewEngine.open(new Uint8Array(preview.bytes).buffer),
      )
      .then((result) => {
        document = result;
        if (active) setPresentation(result);
        else result.dispose();
      })
      .catch((reason: unknown) => {
        if (active) {
          setError("无法预览此 PowerPoint 文件。");
          logRendererError("pptx-preview", reason);
        }
      });
    return () => {
      active = false;
      generation.current += 1;
      document?.dispose();
    };
  }, [preview]);
  const go = useCallback(
    (target: number) => {
      if (!presentation) return;
      const next = clampPresentationPageNumber(target, presentation.pageCount);
      setPage(next);
      setPageInput(String(next));
      setSelected(null);
      setSelectedText("");
      setEditing(false);
      setComment("");
    },
    [presentation],
  );
  const commitPage = () => {
    const value = Number.parseInt(pageInput.trim(), 10);
    if (Number.isNaN(value)) setPageInput(String(page));
    else go(value);
  };
  const elements = useMemo(
    () => (presentation && selectionMode ? presentation.getPageElements(page - 1) : []),
    [presentation, selectionMode, page],
  );
  const scale = presentation
    ? (Math.min(
        Math.max(1, size.width - 32) / presentation.pageSize.width,
        Math.max(1, size.height - 32) / presentation.pageSize.height,
      ) *
        zoom) /
      100
    : 1;
  useLayoutEffect(() => {
    if (!selected || !selectionMode || !viewport) return;
    const update = () => {
      const pageRect = frame.current?.getBoundingClientRect();
      const bounds = viewport.getBoundingClientRect();
      if (!pageRect) return;
      const x = pageRect.left + selected.bounds.x * scale;
      const y = pageRect.top + selected.bounds.y * scale;
      const width = selected.bounds.width * scale;
      const height = selected.bounds.height * scale;
      const actionWidth = actions.current?.offsetWidth ?? (editing ? 320 : 80);
      const actionHeight = actions.current?.offsetHeight ?? 36;
      const left = Math.max(
        bounds.left + 8,
        Math.min(x + width / 2 - actionWidth / 2, bounds.right - actionWidth - 8),
      );
      const top =
        y - actionHeight - 8 >= bounds.top + 8
          ? y - actionHeight - 8
          : Math.min(y + height + 8, bounds.bottom - actionHeight - 8);
      setActionPosition({
        left,
        top: Math.max(bounds.top + 8, top),
        visible: x + width > bounds.left && x < bounds.right && y + height > bounds.top && y < bounds.bottom,
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    if (actions.current) observer.observe(actions.current);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, [selected, selectionMode, viewport, scale, editing]);
  const onLink = (url: string) => paneTask(openWebLink(url, undefined, sessionId));
  const submitReference = () => {
    if (!selected || addingReference) return;
    const requestGeneration = generation.current;
    setAddingReference(true);
    void createPresentationSelection({
      path: preview.path,
      bytes: preview.bytes,
      element: selected,
      comment,
      ...(selectedText ? { selectedText } : {}),
    })
      .then((reference) => {
        if (generation.current !== requestGeneration) return;
        addConversationSelection(reference, sessionId);
        setEditing(false);
        setComment("");
      })
      .catch((reason: unknown) => {
        if (generation.current === requestGeneration)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (generation.current === requestGeneration) setAddingReference(false);
      });
  };
  if (!presentation)
    return (
      <div className="pptx-status" role={error ? "alert" : "status"}>
        {error || "正在加载演示文稿..."}
      </div>
    );
  if (!presentation.pageCount) return <div className="pptx-status">演示文稿没有幻灯片。</div>;
  return (
    <section
      className="pptx-preview"
      aria-label="PowerPoint 预览"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The viewer supports focused left/right page navigation.
      tabIndex={0}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (["INPUT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable) return;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          go(page - 1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          go(page + 1);
        } else if (event.key === "Escape") {
          if (editing) setEditing(false);
          else {
            setSelectionMode(false);
            setSelected(null);
            setSelectedText("");
          }
        }
      }}
    >
      <aside ref={setThumbnails} className="pptx-thumbnails" aria-label="幻灯片缩略图">
        {Array.from({ length: presentation.pageCount }, (_, index) => (
          <Thumbnail
            key={index}
            document={presentation}
            index={index}
            selected={page === index + 1}
            onSelect={() => go(index + 1)}
            root={thumbnails}
          />
        ))}
      </aside>
      <div className="pptx-main">
        {error ? (
          <div className="pptx-status" role="alert">
            {error}
          </div>
        ) : null}
        <div ref={setViewport} className="pptx-viewport">
          <div className="pptx-canvas-area">
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Observes native text selection without replacing keyboard interaction. */}
            <div
              ref={frame}
              role="presentation"
              className="pptx-page-frame"
              onMouseUp={() => {
                if (!selectionMode || !selected) return;
                const selection = window.getSelection();
                if (
                  selection &&
                  !selection.isCollapsed &&
                  selection.anchorNode &&
                  frame.current?.contains(selection.anchorNode)
                )
                  setSelectedText(selection.toString());
              }}
            >
              <Slide
                document={presentation}
                index={page - 1}
                scale={scale}
                onNavigate={(index) => go(index + 1)}
                onLink={onLink}
                onError={(reason) => {
                  setError("幻灯片渲染失败。");
                  logRendererError("pptx-slide", reason);
                }}
              />
              {selectionMode ? (
                <div
                  className="pptx-element-layer"
                  role="presentation"
                  aria-label="选择幻灯片元素"
                  onPointerDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    setSelected(
                      hitTestPresentationElement(elements, {
                        x: (event.clientX - rect.left) / scale,
                        y: (event.clientY - rect.top) / scale,
                      }),
                    );
                    setEditing(false);
                  }}
                >
                  {elements.map((element) => (
                    <button
                      type="button"
                      key={`${element.nodeId}:${element.rowIndex}:${element.cellIndex}`}
                      className="pptx-element"
                      aria-label={element.text || element.nodeName || element.nodeType}
                      aria-pressed={selected === element}
                      style={{
                        left: element.bounds.x * scale,
                        top: element.bounds.y * scale,
                        width: element.bounds.width * scale,
                        height: element.bounds.height * scale,
                        zIndex: element.zIndex,
                        pointerEvents: selected === element ? "none" : "auto",
                      }}
                      onClick={() => {
                        setSelected(element);
                        setSelectedText("");
                        setEditing(false);
                        setComment("");
                      }}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        {selected && selectionMode
          ? createPortal(
              <div
                ref={actions}
                className="pptx-selection-actions"
                role="toolbar"
                aria-label="元素操作"
                style={{
                  left: actionPosition.left,
                  top: actionPosition.top,
                  visibility: actionPosition.visible ? "visible" : "hidden",
                }}
              >
                {editing ? (
                  <>
                    <textarea
                      aria-label="编辑要求"
                      ref={commentInput}
                      placeholder="描述你希望如何修改这个元素..."
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditing(false);
                        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          submitReference();
                        }
                      }}
                    />
                    <button type="button" onClick={() => setEditing(false)}>
                      取消
                    </button>
                    <button type="button" disabled={addingReference} onClick={submitReference}>
                      添加到对话
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => setEditing(true)}>
                    AI 编辑
                  </button>
                )}
              </div>,
              window.document.body,
            )
          : null}
        <div className="pptx-toolbar">
          <button
            type="button"
            aria-pressed={selectionMode}
            onClick={() => {
              setSelectionMode(!selectionMode);
              setSelected(null);
              setSelectedText("");
              setEditing(false);
            }}
          >
            <MousePointer2 />
            {selectionMode ? "退出选择" : "选择元素"}
          </button>
          <button
            type="button"
            title="上一页"
            aria-label="上一页"
            disabled={page <= 1}
            onClick={() => go(page - 1)}
          >
            <ChevronLeft />
          </button>
          <input
            aria-label="页码"
            inputMode="numeric"
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={commitPage}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitPage();
                event.currentTarget.blur();
              }
            }}
          />
          <span>/ {presentation.pageCount}</span>
          <button
            type="button"
            title="下一页"
            aria-label="下一页"
            disabled={page >= presentation.pageCount}
            onClick={() => go(page + 1)}
          >
            <ChevronRight />
          </button>
          <i aria-hidden="true" />
          <button
            type="button"
            title="缩小"
            aria-label="缩小"
            disabled={zoom <= 25}
            onClick={() => setZoom(clampPresentationZoomPercent(zoom - 25))}
          >
            <ZoomOut />
          </button>
          <span>{zoom}%</span>
          <button
            type="button"
            title="放大"
            aria-label="放大"
            disabled={zoom >= 300}
            onClick={() => setZoom(clampPresentationZoomPercent(zoom + 25))}
          >
            <ZoomIn />
          </button>
          {typeof window.zpi.printPageToPdf === "function" || onExportPdf ? (
            <>
              <i aria-hidden="true" />
              <button
                type="button"
                title="导出 PDF"
                aria-label="导出 PDF"
                disabled={exporting}
                onClick={() => {
                  setExporting(true);
                  void exportPdf(presentation, preview.path)
                    .catch((reason: unknown) => {
                      setError("导出 PDF 失败。");
                      logRendererError("pptx-export", reason);
                    })
                    .finally(() => setExporting(false));
                }}
              >
                <FileDown />
              </button>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
