import { Check, Copy, X } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { FileLocation, LinkContext } from "../link-target.ts";

export interface MarkdownServices {
  streaming: boolean;
  workspace?: LinkContext;
  onCopy?: (text: string) => Promise<void>;
  onImage?: (path: string, location?: FileLocation) => Promise<string>;
  onDownloadImage?: (src: string) => Promise<void>;
}
export const MarkdownContext = createContext<MarkdownServices>({ streaming: false });
export const useMarkdown = () => useContext(MarkdownContext);

export function MarkdownCopy({
  text,
  label,
  success = "已复制",
  disabled = false,
}: {
  text: string | (() => string);
  label: string;
  success?: string;
  disabled?: boolean;
}) {
  const { onCopy } = useMarkdown();
  const [status, setStatus] = useState<"idle" | "copying" | "success" | "error">("idle");
  useEffect(() => {
    if (status !== "success") return;
    const timer = setTimeout(() => setStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [status]);
  const title = status === "error" ? "复制失败，点击重试" : status === "success" ? success : label;
  return (
    <button
      type="button"
      className="markdown-action"
      aria-label={title}
      title={title}
      disabled={disabled || !onCopy || status === "copying"}
      onClick={async () => {
        if (!onCopy) return;
        setStatus("copying");
        try {
          await onCopy(typeof text === "function" ? text() : text);
          setStatus("success");
        } catch {
          setStatus("error");
        }
      }}
    >
      {status === "success" ? <Check size={14} /> : <Copy size={14} />}
      <span className="sr-only" role={status === "error" ? "alert" : "status"} aria-live="polite">
        {status === "success" || status === "error" ? title : ""}
      </span>
    </button>
  );
}

export function MarkdownPreview({
  title,
  description,
  children,
  onClose,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.showModal();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`markdown-preview ${className}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button type="button" className="markdown-action" aria-label={`关闭${title}`} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
