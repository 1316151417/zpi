import { Image, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { QuickChatDraftImage } from "./quick-chat-attachments.ts";
import { readQuickChatAttachment } from "./quick-chat-attachments.ts";

/** Uses the task composer's image-chip/lightbox styles without importing its editor or store. */
export function QuickChatAttachment({
  sessionId,
  item,
  disabled,
  onRemove,
  onRetry,
}: {
  sessionId?: string;
  item: QuickChatDraftImage;
  disabled: boolean;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const id = item.image?.id;
  useEffect(() => {
    if (!sessionId || !id) return;
    let active = true;
    setSrc("");
    setError("");
    void readQuickChatAttachment(sessionId, id).then(
      (value) => {
        if (active) setSrc(value);
      },
      (reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [sessionId, id, attempt]);
  const message = item.error || error;
  const busy = item.status === "importing" || item.status === "queued" || item.status === "removing";
  return (
    <div className="quick-chat-attachment" title={message || item.file.name}>
      <div className="image-chip">
        <button
          type="button"
          aria-label={`预览 ${item.file.name}`}
          disabled={!src}
          onClick={() => setExpanded(true)}
        >
          {src ? (
            <img src={src} alt={item.file.name} onError={() => setError("无法预览图片")} />
          ) : (
            <Image size={20} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          aria-label={`移除 ${item.file.name}`}
          className="chip-remove"
          disabled={disabled || item.status === "removing"}
          onClick={onRemove}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      {message ? (
        <button
          type="button"
          className="quick-chat-attachment-status quick-chat-retry"
          aria-label={`重试 ${item.file.name}`}
          title={message}
          disabled={disabled || busy}
          onClick={() => {
            if (item.status === "failed") onRetry();
            else if (item.error) onRemove();
            else setAttempt((value) => value + 1);
          }}
        >
          重试
        </button>
      ) : (
        <span className="quick-chat-attachment-status">{busy ? "处理中…" : item.file.name}</span>
      )}
      {expanded && (
        <dialog
          ref={(element) => {
            if (element && !element.open) element.showModal();
          }}
          className="image-lightbox"
          aria-label="图片预览"
          onClick={(event) => {
            if (event.target === event.currentTarget) setExpanded(false);
          }}
          onCancel={(event) => {
            event.preventDefault();
            setExpanded(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setExpanded(false);
            }
          }}
        >
          <button type="button" aria-label="关闭图片预览" onClick={() => setExpanded(false)}>
            <X size={20} aria-hidden="true" />
          </button>
          {src && <img src={src} alt={item.file.name} />}
          <span>{item.file.name}</span>
        </dialog>
      )}
    </div>
  );
}
