import { ChevronLeft, ChevronRight, Download, Image as ImageIcon, ImageOff, Minus, Plus } from "lucide-react";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import type { ExtraProps } from "streamdown";
import { resolveLinkTarget } from "../link-target.ts";
import { MarkdownPreview, useMarkdown } from "./MarkdownActions.tsx";

export function MarkdownImage({ src, alt = "图片预览", node }: ComponentProps<"img"> & ExtraProps) {
  const { onImage, onDownloadImage, workspace } = useMarkdown();
  const original = node?.properties?.dataZPITarget;
  const target = typeof original === "string" ? original : typeof src === "string" ? src : "";
  const resolved = resolveLinkTarget(target, workspace);
  const path = resolved?.kind === "file" ? resolved.path : undefined;
  const relative = resolved?.kind === "file" && resolved.relative;
  const [local, setLocal] = useState<{ path: string; src?: string; failed?: boolean }>();
  const [status, setStatus] = useState<{ src: string; failed?: boolean }>();
  const [preview, setPreview] = useState<{ items: { src: string; alt: string }[]; index: number }>();
  const [downloadError, setDownloadError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const pointer = useRef<{ x: number; y: number; pan: typeof pan } | undefined>(undefined);
  useEffect(() => {
    if (!path || !onImage) return;
    let active = true;
    void onImage(path, { relative }).then(
      (src) => {
        if (active) setLocal({ path, src });
      },
      () => {
        if (active) setLocal({ path, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [target, path, relative, onImage]);
  const display = path
    ? local?.path === path
      ? local.src
      : undefined
    : resolved?.kind === "web" || /^data:image\//i.test(target)
      ? target
      : undefined;
  const failed = Boolean(
    (!resolved && !/^data:image\//i.test(target)) ||
      (path && ((local?.path === path && local.failed) || !onImage)) ||
      (status?.src === display && status?.failed),
  );
  const loaded = Boolean(display && status?.src === display && !status?.failed);
  const change = (index: number) => {
    setPreview((old) => (old ? { ...old, index } : old));
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setDownloadError("");
  };
  if (!target) return null;
  return (
    <>
      <button
        type="button"
        className={`markdown-image-trigger ${loaded ? "" : "pending"}`}
        data-markdown-image-trigger=""
        aria-label={failed ? "图片无法显示" : "打开图片预览"}
        disabled={!loaded}
        onClick={(event) => {
          const group = event.currentTarget.closest(".markdown-image-gallery") ?? event.currentTarget;
          const items = Array.from(group.querySelectorAll<HTMLImageElement>("img"))
            .filter((image) => image.complete && image.naturalWidth)
            .map((image) => ({ src: image.src, alt: image.alt }));
          setPreview({
            items,
            index: Math.max(
              0,
              items.findIndex((item) => item.src === display),
            ),
          });
        }}
      >
        {!loaded && (
          <span role="status">
            <span className="sr-only">{failed ? "图片无法显示" : "正在加载图片"}</span>
            {failed ? <ImageOff size={24} /> : <ImageIcon size={24} />}
          </span>
        )}
        {display && !failed && (
          <img
            key={display}
            src={display}
            alt={alt}
            loading="lazy"
            draggable={false}
            data-streamdown="image"
            onLoad={() => setStatus({ src: display })}
            onError={() => setStatus({ src: display, failed: true })}
          />
        )}
      </button>
      {preview?.items[preview.index] && (
        <MarkdownPreview
          title="图片预览"
          className="markdown-image-preview"
          onClose={() => {
            setPreview(undefined);
            setDownloadError("");
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          <div className="markdown-image-preview-toolbar">
            <button
              type="button"
              className="markdown-action"
              aria-label="上一张图片"
              disabled={preview.index === 0}
              onClick={() => change(preview.index - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              {preview.index + 1} / {preview.items.length}
            </span>
            <button
              type="button"
              className="markdown-action"
              aria-label="下一张图片"
              disabled={preview.index === preview.items.length - 1}
              onClick={() => change(preview.index + 1)}
            >
              <ChevronRight size={16} />
            </button>
            <button
              type="button"
              className="markdown-action"
              aria-label="缩小"
              disabled={zoom <= 0.25}
              onClick={() => {
                setZoom((value) => Math.max(0.25, value - 0.25));
                setPan({ x: 0, y: 0 });
              }}
            >
              <Minus size={16} />
            </button>
            <button
              type="button"
              className="markdown-action"
              aria-label="放大"
              disabled={zoom >= 4}
              onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
            >
              <Plus size={16} />
            </button>
            <a
              className="markdown-action"
              aria-label="下载图片"
              title="下载图片"
              href={preview.items[preview.index].src}
              download={alt || "image"}
              onClick={async (event) => {
                if (!onDownloadImage) return;
                event.preventDefault();
                setDownloadError("");
                try {
                  await onDownloadImage(preview.items[preview.index].src);
                } catch {
                  setDownloadError("图片下载失败，请重试");
                }
              }}
            >
              <Download size={16} />
            </a>
          </div>
          {downloadError && (
            <p role="alert" className="run-error">
              {downloadError}
            </p>
          )}
          <div
            className="markdown-image-canvas"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              pointer.current = { x: event.clientX, y: event.clientY, pan };
            }}
            onPointerMove={(event) => {
              const start = pointer.current;
              const canvas = event.currentTarget;
              const image = canvas.querySelector("img");
              if (start && image) {
                const maxX = Math.max(0, (image.clientWidth * zoom - canvas.clientWidth) / 2);
                const maxY = Math.max(0, (image.clientHeight * zoom - canvas.clientHeight) / 2);
                setPan({
                  x: Math.max(-maxX, Math.min(maxX, start.pan.x + event.clientX - start.x)),
                  y: Math.max(-maxY, Math.min(maxY, start.pan.y + event.clientY - start.y)),
                });
              }
            }}
            onPointerUp={() => {
              pointer.current = undefined;
            }}
            onPointerCancel={() => {
              pointer.current = undefined;
            }}
          >
            <img
              src={preview.items[preview.index].src}
              alt={preview.items[preview.index].alt}
              draggable={false}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            />
          </div>
        </MarkdownPreview>
      )}
    </>
  );
}
