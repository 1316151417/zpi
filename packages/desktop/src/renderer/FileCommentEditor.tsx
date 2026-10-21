import { useLayoutEffect, useRef } from "react";
import type { FileCommentRange } from "./file-comments.ts";
export function FileCommentEditor({
  range,
  text,
  onText,
  onCancel,
  onSubmit,
  error,
}: {
  range: FileCommentRange;
  text: string;
  onText: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  error?: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  // A new range object requests focus again, including another click on the same line.
  useLayoutEffect(() => {
    const textarea = input.current;
    if (!textarea) return;
    const shadow = textarea.closest("[slot]")?.parentElement?.shadowRoot;
    // Subscribe before Pierre's parent layout effect renders the annotation slot.
    // Focus during slot assignment, before the next keyboard event can reach the old target.
    const focus = () => {
      if (!textarea.isConnected || !textarea.getClientRects().length) return;
      textarea.focus();
      if (document.activeElement === textarea) cleanup();
    };
    const cleanup = () => {
      shadow?.removeEventListener("slotchange", focus);
      document.removeEventListener("pointerdown", cleanup, true);
      document.removeEventListener("keydown", cleanup, true);
    };
    shadow?.addEventListener("slotchange", focus);
    // A later user action supersedes this pending focus request.
    document.addEventListener("pointerdown", cleanup, true);
    document.addEventListener("keydown", cleanup, true);
    focus();
    return cleanup;
  }, [range]);
  return (
    <div className="file-comment-card" data-file-comment-draft="">
      <div className="file-comment-range">
        {range.start === range.end
          ? `评论第 ${range.start} 行`
          : `评论第 ${range.start} 行到第 ${range.end} 行`}
      </div>
      <textarea
        ref={input}
        rows={3}
        aria-label="代码备注"
        placeholder="可选：为这段代码补充评论..."
        value={text}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      {error && (
        <p className="run-error" role="alert">
          {error}
        </p>
      )}
      <div className="file-comment-actions">
        <button onClick={onCancel}>
          取消 <kbd>Esc</kbd>
        </button>
        <button className="primary" onClick={onSubmit}>
          添加到对话 <kbd>{window.zpi.platform === "darwin" ? "⌘↵" : "Ctrl↵"}</kbd>
        </button>
      </div>
    </div>
  );
}
