// Geometry, labels and Lucide assets follow ZCode TaskFindDialog (Apache-2.0).
import { ArrowDown, ArrowUp, FileDiff, MessageCircle, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { type FindRequest, type FindState, findKeyDirection, moveFindIndex } from "../find.ts";
import { ActionHint } from "./MessageActions.tsx";

export function TaskFindBar({
  request,
  state,
  scope,
  focusRequestId,
  onChange,
  onNavigate,
  onToggleScope,
  onClose,
}: {
  request: FindRequest;
  state: FindState;
  scope: "conversation" | "changes";
  focusRequestId: number;
  onChange: (query: string) => void;
  onNavigate: (index: number) => void;
  onToggleScope: () => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusRequestId]);
  const move = (direction: "previous" | "next") => {
    if (state.total) onNavigate(moveFindIndex(state, direction));
  };
  const button = (label: string, icon: ReactNode, action: () => void, disabled = false, hint = label) => (
    <ActionHint label={hint}>
      <span className="task-find-action">
        <button type="button" aria-label={label} disabled={disabled} onClick={action}>
          {icon}
        </button>
      </span>
    </ActionHint>
  );
  return (
    <div role="dialog" aria-modal="false" aria-label="在任务中查找" className="task-find-bar">
      <Search size={14} aria-hidden="true" />
      <input
        ref={input}
        aria-label={scope === "conversation" ? "搜索消息" : "搜索文件变更"}
        placeholder={scope === "conversation" ? "搜索消息..." : "搜索文件变更..."}
        value={request.query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          const direction = findKeyDirection(event.key, event.shiftKey);
          if (direction) {
            event.preventDefault();
            move(direction);
          }
        }}
      />
      <span className="task-find-count" role="status" aria-live="polite">
        {state.total ? `${state.activeIndex + 1}/${state.total}` : "0/0"}
      </span>
      <div className="task-find-controls">
        {button("上一个结果", <ArrowUp size={14} />, () => move("previous"), !state.total)}
        {button("下一个结果", <ArrowDown size={14} />, () => move("next"), !state.total)}
        {button(
          scope === "conversation" ? "搜索文件变更" : "搜索消息",
          scope === "conversation" ? <MessageCircle size={14} /> : <FileDiff size={14} />,
          onToggleScope,
          false,
          "切换搜索范围消息/文件",
        )}
      </div>
      <div className="task-find-close">{button("关闭查找", <X size={14} />, onClose)}</div>
    </div>
  );
}
