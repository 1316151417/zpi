import { File } from "@pierre/diffs/react";
import { Trash2 } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type ConversationSelection,
  ConversationSelectionMenu,
  type FileAction,
  Markdown,
  MermaidBlock,
  useAppearance,
} from "zpi-ui";
import type { FileLocation, WebOpenOptions } from "zpi-ui/links";
import type { FilePreview } from "../shared/bridge.ts";
import { FileCommentEditor } from "./FileCommentEditor.tsx";
import { FilePreviewBoundary } from "./FilePreviewBoundary.tsx";
import {
  addFileCommentToDraft,
  type FileComment,
  type FileCommentRange,
  fileComments,
  normalizeFileCommentRange,
  removeFileCommentFromDraft,
} from "./file-comments.ts";
import { fileGutterCSS, observeFileGutterLabels } from "./file-gutter.ts";
import { readMarkdownImage } from "./markdown-image.ts";
import { PreviewHeader } from "./PreviewHeader.tsx";
import { openFile, openSideChat, openWebLink, paneTask, useSideChatBlocked } from "./pane-store.ts";
import { inferPreviewLanguage } from "./preview-language.ts";
import { addConversationSelection, drafts, unwrap, useStore } from "./store.ts";
import { useWorkspace } from "./use-workspace.ts";
import { userErrorMessage } from "./user-error.ts";

const OfficePreview = lazy(() => import("./OfficePreview.tsx"));
const PdfPreview = lazy(() => import("./PdfPreview.tsx"));
const PptxPreview = lazy(() => import("./PptxPreview.tsx"));
const copyText = (text: string) => window.zpi.copyText(text).then(unwrap);
const downloadImage = (src: string) => window.zpi.downloadImage(src).then(unwrap);

function MediaPreview({ preview }: { preview: Extract<FilePreview, { bytes: Uint8Array }> }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(preview.bytes)], { type: preview.mime }));
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [preview]);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [mediaError, setMediaError] = useState(false);
  useEffect(() => {
    setMediaError(false);
    setNaturalSize({ width: 0, height: 0 });
  }, [preview]);
  if (!src) return null;
  if (mediaError)
    return (
      <p className="run-error" role="alert">
        无法播放此媒体格式，请在外部应用中打开。
      </p>
    );
  const ratio = Number(/@(\d+(?:\.\d+)?)x(?=(?:\.[^./\\]+)?$)/i.exec(preview.path)?.[1] ?? 1);
  return preview.kind === "image" ? (
    <div className="file-image-preview">
      <img
        src={src}
        alt={preview.path.split("/").at(-1)}
        onLoad={(event) =>
          setNaturalSize({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })
        }
        style={
          ratio > 1 && naturalSize.width
            ? { width: naturalSize.width / ratio, height: naturalSize.height / ratio }
            : undefined
        }
      />
    </div>
  ) : (
    <div className="file-media-container">
      {preview.mime?.startsWith("audio/") ? (
        // biome-ignore lint/a11y/useMediaCaption: Local previews have no authored caption track.
        <audio
          className="file-media-preview"
          src={src}
          controls
          preload="metadata"
          onError={() => setMediaError(true)}
        />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: Local previews have no authored caption track.
        <video
          className="file-media-preview"
          src={src}
          controls
          playsInline
          preload="metadata"
          onError={() => setMediaError(true)}
        />
      )}
    </div>
  );
}

export function FilePane({ preview, sessionId }: { preview: FilePreview; sessionId: string }) {
  const { theme } = useAppearance();
  const openLink = useCallback(
    (url: string, options?: WebOpenOptions) => paneTask(openWebLink(url, options, sessionId)),
    [sessionId],
  );
  const positioned = useRef<FilePreview | undefined>(undefined);
  const selectionRoot = useRef<HTMLDivElement>(null);
  const currentTask = useStore((state) => state.selected);
  const sideChatAvailable = useStore((state) => {
    const record = state.sessions.get(currentTask ?? "");
    return Boolean(record && !record.draft && !record.parentSessionId && record.archivedAt == null);
  });
  const parentBlocked = useStore((state) => Boolean(state.views.get(currentTask ?? "")?.question));
  const sideChatBlocked = useSideChatBlocked(currentTask) || parentBlocked;
  const addSelection = useCallback(
    (reference: ConversationSelection) => addConversationSelection(reference, sessionId),
    [sessionId],
  );
  const askInSideChat = useCallback(
    (reference: ConversationSelection) => {
      if (currentTask) paneTask(openSideChat(currentTask, reference));
    },
    [currentTask],
  );
  const [wrap, setWrap] = useState(false);
  const [commentRange, setCommentRange] = useState<FileCommentRange | null>(null);
  const [commentText, setCommentText] = useState("");
  const [commentError, setCommentError] = useState("");
  const draft = useSyncExternalStore(
    useCallback(
      (notify) =>
        drafts.subscribe((id) => {
          if (id === sessionId) notify();
        }),
      [sessionId],
    ),
    useCallback(() => drafts.get(sessionId), [sessionId]),
  );
  const comments = useMemo(
    () => fileComments(draft?.selections ?? [], preview.path),
    [draft?.selections, preview.path],
  );
  const beginComment = useCallback(
    (range: FileCommentRange | null) => {
      if (!range || preview.kind !== "text") return;
      setCommentRange(normalizeFileCommentRange(range, preview.text));
      setCommentText("");
      setCommentError("");
    },
    [preview],
  );
  useEffect(() => {
    setCommentRange(null);
    setCommentText("");
    setCommentError("");
  }, [sessionId, preview]);
  useEffect(() => {
    const root = selectionRoot.current;
    return root && draft ? observeFileGutterLabels(root) : undefined;
  }, [Boolean(draft), preview]);
  const submitComment = () => {
    const current = drafts.get(sessionId);
    if (!commentRange || !current || preview.kind !== "text") return;
    try {
      addFileCommentToDraft(
        drafts,
        sessionId,
        preview.path,
        preview.text,
        commentRange,
        commentText,
        crypto.randomUUID(),
      );
      setCommentRange(null);
      setCommentText("");
    } catch (error) {
      setCommentError(userErrorMessage(error));
    }
  };
  const removeComment = (id: string) => removeFileCommentFromDraft(drafts, sessionId, id);
  const [renderMarkdown, setRenderMarkdown] = useState(!preview.location?.line);
  useEffect(() => {
    if (preview.location?.line) setRenderMarkdown(false);
  }, [preview]);
  const workspace = useWorkspace(sessionId);
  const markdownWorkspace = useMemo(
    () => ({ ...workspace, documentPath: preview.path }),
    [workspace, preview.path],
  );
  // Refresh reloads embedded images; unrelated UI renders do not repeat filesystem reads.
  const readImage = useCallback(
    (path: string, location?: FileLocation) => readMarkdownImage(sessionId, path, location),
    [sessionId, preview],
  );
  const openReference = useCallback(
    (path: string, location?: FileLocation) => paneTask(openFile(sessionId, path, location)),
    [sessionId],
  );
  const fileAction = useCallback(
    (path: string, action: FileAction, location?: FileLocation) =>
      window.zpi.fileAction(sessionId, path, action, location).then(unwrap),
    [sessionId],
  );
  const markdown = /\.(?:md|markdown)$/i.test(preview.path) && preview.kind === "text";
  const svg = /\.svg$/i.test(preview.path) && preview.kind === "text";
  const file = useMemo(
    () => ({
      name: preview.path,
      contents: preview.kind === "text" ? preview.text : "",
      lang:
        preview.kind === "text" && preview.text.length > 180000
          ? ("text" as const)
          : inferPreviewLanguage(preview.path, preview.kind === "text" ? preview.text : undefined),
    }),
    [preview],
  );
  return (
    <section className="file-pane" aria-label="文件预览">
      <PreviewHeader
        sessionId={sessionId}
        path={preview.path}
        divider={["pdf", "pptx", "docx", "doc", "xlsx", "media"].includes(preview.kind)}
        wrap={wrap}
        onWrap={
          preview.kind === "text" && (!(markdown || svg) || !renderMarkdown)
            ? () => setWrap(!wrap)
            : undefined
        }
        viewKind={svg ? "SVG" : "Markdown"}
        viewMode={renderMarkdown ? "preview" : "code"}
        onViewMode={markdown || svg ? (mode) => setRenderMarkdown(mode === "preview") : undefined}
      />
      <ConversationSelectionMenu
        rootRef={selectionRoot}
        scopeKey={`${sessionId}:${preview.path}`}
        onAdd={draft ? addSelection : undefined}
        onSideChat={askInSideChat}
        sideChatDisabled={!sideChatAvailable || sideChatBlocked}
        sideChatDisabledTitle={
          sideChatBlocked
            ? "请先处理主任务或辅助对话中的待处理请求。"
            : "请在支持辅助对话的可编辑主任务中使用。"
        }
      />
      <FilePreviewBoundary preview={preview}>
        {preview.kind === "text" ? (
          <div
            ref={selectionRoot}
            className="file-text-preview"
            data-line={preview.location?.line}
            data-column={preview.location?.column}
          >
            {preview.truncated && <p className="run-notice">文件较大，显示前 2 MB。</p>}
            {/\.(?:mmd|mermaid)$/i.test(preview.path) ? (
              <div className="file-mermaid-preview">
                <MermaidBlock code={preview.text} />
              </div>
            ) : markdown && renderMarkdown ? (
              <div
                className="answer file-markdown-preview"
                data-conversation-selectable="markdown"
                data-selection-key={preview.path}
                data-selection-path={preview.path}
                data-selection-title={preview.path}
              >
                <Markdown
                  workspace={markdownWorkspace}
                  onImage={readImage}
                  onDownloadImage={downloadImage}
                  text={preview.text}
                  streaming={false}
                  onCopy={copyText}
                  onLink={openLink}
                  onFile={openReference}
                  onFileAction={fileAction}
                />
              </div>
            ) : svg && renderMarkdown ? (
              <div className="file-image-preview">
                <img
                  className="file-svg-preview"
                  alt={preview.path.split("/").at(-1)}
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.text)}`}
                />
              </div>
            ) : (
              <File<{ kind: "comment"; comment: FileComment } | { kind: "draft" }>
                file={file}
                lineAnnotations={[
                  ...comments.map((comment) => ({
                    lineNumber: comment.end,
                    metadata: { kind: "comment" as const, comment },
                  })),
                  ...(commentRange
                    ? [{ lineNumber: commentRange.end, metadata: { kind: "draft" as const } }]
                    : []),
                ]}
                renderAnnotation={({ metadata }) =>
                  metadata.kind === "draft" && commentRange ? (
                    <FileCommentEditor
                      range={commentRange}
                      text={commentText}
                      onText={setCommentText}
                      onCancel={() => setCommentRange(null)}
                      onSubmit={submitComment}
                      error={commentError}
                    />
                  ) : metadata.kind === "comment" ? (
                    <div className="file-comment-card" data-file-comment-id={metadata.comment.id}>
                      <div className="file-comment-range">
                        {metadata.comment.start === metadata.comment.end
                          ? `评论第 ${metadata.comment.start} 行`
                          : `评论第 ${metadata.comment.start} 行到第 ${metadata.comment.end} 行`}
                      </div>
                      {metadata.comment.comment && (
                        <div className="file-comment-text">{metadata.comment.comment}</div>
                      )}
                      <div className="file-comment-actions">
                        <button aria-label="删除评论" onClick={() => removeComment(metadata.comment.id)}>
                          <Trash2 size={16} />
                          删除评论
                        </button>
                      </div>
                    </div>
                  ) : null
                }
                // Pierre treats undefined as uncontrolled; null clears its internal drag selection.
                selectedLines={
                  commentRange ??
                  (preview.location?.line
                    ? { start: preview.location.line, end: preview.location.endLine ?? preview.location.line }
                    : null)
                }
                options={{
                  enableLineSelection: Boolean(draft),
                  enableGutterUtility: Boolean(draft),
                  lineHoverHighlight: draft ? "both" : "disabled",
                  onLineSelectionEnd: beginComment,
                  onGutterUtilityClick: beginComment,
                  unsafeCSS: fileGutterCSS,
                  onPostRender: (node) => {
                    if (!preview.location?.line || positioned.current === preview) return;
                    requestAnimationFrame(() => {
                      const line = node.shadowRoot?.querySelector<HTMLElement>(
                        `[data-line="${preview.location?.line}"]`,
                      );
                      if (line?.isConnected) {
                        positioned.current = preview;
                        const container = selectionRoot.current;
                        if (container) {
                          const top =
                            line.getBoundingClientRect().top - container.getBoundingClientRect().top;
                          container.scrollTop = Math.max(
                            0,
                            container.scrollTop +
                              top -
                              container.clientHeight / 2 +
                              line.getBoundingClientRect().height / 2,
                          );
                        }
                      }
                    });
                  },
                  disableFileHeader: true,
                  theme: { light: "github-light", dark: "github-dark" },
                  themeType: theme,
                  overflow: wrap ? "wrap" : "scroll",
                }}
              />
            )}
          </div>
        ) : preview.kind === "image" || preview.kind === "media" ? (
          <MediaPreview preview={preview} />
        ) : preview.kind === "pptx" ? (
          <Suspense fallback={<p className="pane-empty">正在加载演示文稿…</p>}>
            <PptxPreview sessionId={sessionId} preview={preview} />
          </Suspense>
        ) : preview.kind === "pdf" ? (
          <Suspense fallback={<p className="pane-empty">正在加载 PDF…</p>}>
            <PdfPreview sessionId={sessionId} preview={preview} />
          </Suspense>
        ) : preview.kind === "xlsx" || preview.kind === "docx" || preview.kind === "doc" ? (
          <Suspense fallback={<p className="pane-empty">正在加载文件…</p>}>
            <OfficePreview sessionId={sessionId} preview={preview} />
          </Suspense>
        ) : (
          <p className="pane-empty">此文件类型暂不支持预览。</p>
        )}
      </FilePreviewBoundary>
    </section>
  );
}
