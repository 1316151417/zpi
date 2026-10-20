import { useEffect, useRef } from "react";
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
  useEffect(() => {
    // 与 ZCode 一致，等代码预览的 annotation slot 完成本帧更新后再聚焦。
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [range.start, range.end]);
  return (
    <div className="file-comment-card" data-file-comment-draft="">
      <div className="file-comment-range">
        {range.start === range.end
          ? `评论第 ${range.start} 行`
          : `评论第 ${range.start} 行到第 ${range.end} 行`}
      </div>
      <textarea
        ref={input}
        // biome-ignore lint/a11y/noAutofocus: The user explicitly opens this comment editor.
        autoFocus
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
