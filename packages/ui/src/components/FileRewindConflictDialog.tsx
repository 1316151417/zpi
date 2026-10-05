// Edit conflict layout and Chinese copy follow ZCode ConversationFileRewindDialog (Apache-2.0).
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { FileRewindConflict } from "../types.ts";

export function FileRewindConflictDialog({
  conflicts,
  pending,
  onClose,
  onContinue,
}: {
  conflicts: FileRewindConflict[];
  pending: boolean;
  onClose: () => void;
  onContinue: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="file-rewind-conflict"
      aria-labelledby="file-rewind-conflict-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <button
        className="file-rewind-conflict-close"
        type="button"
        aria-label="关闭"
        disabled={pending}
        onClick={onClose}
      >
        <X size={16} />
      </button>
      <h3 id="file-rewind-conflict-title">文件无法安全重置</h3>
      <p>对话尚未裁剪。请检查冲突或忽略的文件，然后仅重置对话并发送，或取消。</p>
      <section>
        {[false, true].map((ignored) => {
          const files = conflicts.filter((file) => Boolean(file.ignored) === ignored);
          return (
            files.length > 0 && (
              <div key={String(ignored)}>
                <h4>
                  {ignored ? "已忽略" : "不能安全撤销"} {files.length}
                </h4>
                {files.map((file) => (
                  <div className="file-rewind-conflict-file" key={file.path}>
                    <span>{file.path}</span>
                    <small>{file.reason}</small>
                  </div>
                ))}
              </div>
            )
          );
        })}
      </section>
      <footer>
        <button type="button" disabled={pending} onClick={onClose}>
          取消
        </button>
        <button className="primary" type="button" disabled={pending} onClick={onContinue}>
          仅重置对话并发送
        </button>
      </footer>
    </dialog>
  );
}
