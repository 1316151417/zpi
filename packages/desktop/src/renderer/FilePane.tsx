import { File } from "@pierre/diffs/react";
import { Copy, RefreshCw, WrapText } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationSelectionMenu, type FileAction, FileIcon, Markdown, useAppearance } from "zpi-ui";
import type { FileLocation, WebOpenOptions } from "zpi-ui/links";
import type { FilePreview } from "../shared/bridge.ts";
import { readMarkdownImage } from "./markdown-image.ts";
import { openFile, openWebLink, paneTask } from "./pane-store.ts";
import { addConversationSelection, unwrap, useStore } from "./store.ts";
import { useWorkspace } from "./use-workspace.ts";

const OfficePreview = lazy(() => import("./OfficePreview.tsx"));
const copyText = (text: string) => window.zpi.copyText(text).then(unwrap);
const downloadImage = (src: string) => window.zpi.downloadImage(src).then(unwrap);
const openLink = (url: string, options?: WebOpenOptions) => paneTask(openWebLink(url, options));

function MediaPreview({ preview }: { preview: Extract<FilePreview, { bytes: Uint8Array }> }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(preview.bytes)], { type: preview.mime }));
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [preview]);
  if (!src) return null;
  return preview.kind === "image" ? (
    <div className="file-image-preview">
      <img src={src} alt={preview.path.split("/").at(-1)} />
    </div>
  ) : preview.mime?.startsWith("audio/") ? (
    // biome-ignore lint/a11y/useMediaCaption: Local previews have no authored caption track.
    <audio className="file-media-preview" src={src} controls />
  ) : (
    // biome-ignore lint/a11y/useMediaCaption: Local previews have no authored caption track.
    <video className="file-media-preview" src={src} controls />
  );
}

export function FilePane({ preview, sessionId }: { preview: FilePreview; sessionId: string }) {
  const { theme } = useAppearance();
  const positioned = useRef<FilePreview | undefined>(undefined);
  const selectionRoot = useRef<HTMLDivElement>(null);
  const currentTask = useStore((state) => state.selected);
  const addSelection = useCallback(
    (reference: import("zpi-ui").ConversationSelection) => addConversationSelection(reference, currentTask),
    [currentTask],
  );
  const [wrap, setWrap] = useState(false);
  const [renderMarkdown, setRenderMarkdown] = useState(!preview.location?.line);
  useEffect(() => {
    if (preview.location?.line) setRenderMarkdown(false);
  }, [preview]);
  const workspace = useWorkspace(sessionId);
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
  const markdown = /\.md$/i.test(preview.path) && preview.kind === "text";
  const file = useMemo(
    () => ({ name: preview.path, contents: preview.kind === "text" ? preview.text : "" }),
    [preview],
  );
  const [error, setError] = useState("");
  const task = (promise: Promise<unknown>) => {
    setError("");
    void promise.catch((error) => setError(String(error)));
  };
  return (
    <section className="file-pane" aria-label="文件预览">
      <div className="pane-subheading file-preview-heading">
        <FileIcon path={preview.path} />
        <span title={preview.path}>{preview.path}</span>
        {preview.location?.line && (
          <span className="file-location">
            第 {preview.location.line} 行
            {preview.location.column ? ` · 第 ${preview.location.column} 列` : ""}
          </span>
        )}
        {markdown && (
          <button aria-pressed={renderMarkdown} onClick={() => setRenderMarkdown(!renderMarkdown)}>
            {renderMarkdown ? "源码" : "预览"}
          </button>
        )}
        {preview.kind === "text" && (
          <>
            <button aria-label="自动换行" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
              <WrapText size={15} />
            </button>
            <button
              aria-label="复制文件内容"
              onClick={() => task(window.zpi.copyText(preview.text).then(unwrap))}
            >
              <Copy size={15} />
            </button>
          </>
        )}
        <button
          aria-label="刷新文件"
          onClick={() => task(openFile(sessionId, preview.path, preview.location))}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <ConversationSelectionMenu
        rootRef={selectionRoot}
        scopeKey={`${currentTask}:${preview.path}`}
        onAdd={currentTask ? addSelection : undefined}
      />
      {error && (
        <p role="alert" className="run-error">
          {error}
        </p>
      )}
      {preview.kind === "text" ? (
        <div
          ref={selectionRoot}
          className="file-text-preview"
          data-line={preview.location?.line}
          data-column={preview.location?.column}
        >
          {preview.truncated && <p className="run-notice">文件较大，显示前 2 MB。</p>}
          {markdown && renderMarkdown ? (
            <div
              className="answer file-markdown-preview"
              data-conversation-selectable="markdown"
              data-selection-key={preview.path}
              data-selection-path={preview.path}
              data-selection-title={preview.path}
            >
              <Markdown
                workspace={workspace}
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
          ) : preview.text.length > 180000 ? (
            <pre
              ref={(node) => {
                if (node?.parentElement && preview.location?.line)
                  node.parentElement.scrollTop =
                    (preview.location.line - 1) *
                    (Number.parseFloat(getComputedStyle(node).lineHeight) || 20);
              }}
              className={`file-plain-preview ${wrap ? "wrap" : ""}`}
            >
              {preview.text}
            </pre>
          ) : (
            <File
              file={file}
              selectedLines={
                preview.location?.line
                  ? { start: preview.location.line, end: preview.location.endLine ?? preview.location.line }
                  : undefined
              }
              options={{
                onPostRender: (node) => {
                  if (!preview.location?.line || positioned.current === preview) return;
                  requestAnimationFrame(() => {
                    const line = node.shadowRoot?.querySelector<HTMLElement>(
                      `[data-line="${preview.location?.line}"]`,
                    );
                    if (line?.isConnected) {
                      positioned.current = preview;
                      line.scrollIntoView({ block: "center" });
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
      ) : preview.kind === "xlsx" || preview.kind === "docx" ? (
        <Suspense fallback={<p className="pane-empty">正在加载文件…</p>}>
          <OfficePreview preview={preview} />
        </Suspense>
      ) : (
        <p className="pane-empty">此文件类型暂不支持预览。</p>
      )}
    </section>
  );
}
