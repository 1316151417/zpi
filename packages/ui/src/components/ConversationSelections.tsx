// Adapted from ZCode selection guard/menu and ContextAttachmentPill (Apache-2.0).
import * as HoverCard from "@radix-ui/react-hover-card";
import { Quote, Trash2, X } from "lucide-react";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConversationSelection } from "../conversation-selections.ts";

export function SelectionReferenceChip({
  references,
  onChange,
}: {
  references: ConversationSelection[];
  onChange?: (value: ConversationSelection[]) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!references.length) setOpen(false);
  }, [references.length]);
  if (!references.length) return null;
  const label =
    references.length === 1 && references[0].path
      ? `${references[0].path.split(/[\\/]/).pop()} · 引用`
      : `${references.length} 条${references.some((ref) => ref.path) ? "引用" : "对话引用"}`;
  return (
    <HoverCard.Root openDelay={0} closeDelay={0} open={open} onOpenChange={setOpen}>
      <HoverCard.Trigger asChild>
        {/* biome-ignore lint/a11y/useSemanticElements: Match ZCode's focusable pill with a separate remove button. */}
        <div
          className="selection-reference-chip"
          role="button"
          tabIndex={0}
          aria-label={label}
          data-conversation-selection-reference-count={references.length}
        >
          <Quote size={16} />
          <span>{label}</span>
          {onChange && (
            <button
              type="button"
              className="selection-remove-all"
              aria-label="移除对话引用"
              onClick={(event) => {
                event.stopPropagation();
                onChange([]);
                setOpen(false);
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          role="dialog"
          aria-label="引用内容"
          className="selection-reference-popover"
          side="top"
          sideOffset={4}
          align={onChange ? "start" : "end"}
          collisionPadding={12}
        >
          {references.map((reference, index) => (
            <div className="selection-reference-detail" key={reference.id ?? index}>
              <Quote size={16} />
              <div>
                <p>{reference.text}</p>
                {(reference.path || reference.sourceTitle) && (
                  <small>{reference.path || reference.sourceTitle}</small>
                )}
              </div>
              {onChange && (
                <button
                  type="button"
                  aria-label="移除对话引用"
                  onClick={() => onChange(references.filter((_, i) => i !== index))}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
interface SelectionState {
  text: string;
  sourceKey: string;
  contentType: ConversationSelection["contentType"];
  path?: string;
  sourceTitle?: string;
  top: number;
  bottom: number;
  center: number;
}
export function ConversationSelectionMenu({
  rootRef,
  scopeKey,
  onAdd,
}: {
  rootRef: RefObject<HTMLElement | null>;
  scopeKey: string;
  onAdd?: (reference: ConversationSelection) => void;
}) {
  const [snapshot, setSnapshot] = useState<{ scopeKey: string; selection: SelectionState }>();
  const menu = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const close = useCallback(() => {
    cancelAnimationFrame(frame.current);
    setSnapshot(undefined);
  }, []);
  useEffect(() => {
    close();
    const root = rootRef.current;
    if (!root || !onAdd) return;
    const element = (node: Node) => (node instanceof Element ? node : node.parentElement);
    // 正文链接用按钮拦截原生跳转，但其文字仍属于消息选区，不能按操作控件排除。
    const excluded =
      "button:not([data-conversation-inline-link]),input,textarea,[role=button]:not([data-conversation-inline-link]),[role=dialog],[contenteditable=true],[data-conversation-selection-tooltip]";
    const dismiss = () => {
      close();
      const selected = window.getSelection();
      if (selected?.rangeCount && root.contains(selected.getRangeAt(0).commonAncestorContainer))
        selected.removeAllRanges();
    };
    const leaveSelection = (event: Event) => {
      const target = event.target instanceof Node ? element(event.target) : null;
      if (target?.closest("[data-conversation-selection-tooltip]")) return;
      if (
        !target ||
        !root.contains(target) ||
        !target.closest("[data-conversation-selectable]") ||
        target.closest(excluded)
      )
        dismiss();
    };
    const inspect = () => {
      const selected = window.getSelection();
      if (!selected || selected.isCollapsed || selected.rangeCount !== 1) {
        close();
        return;
      }
      const range = selected.getRangeAt(0);
      const start = element(range.startContainer),
        end = element(range.endContainer);
      const region = start?.closest<HTMLElement>("[data-conversation-selectable]");
      if (
        !region ||
        region !== end?.closest("[data-conversation-selectable]") ||
        !root.contains(region) ||
        start?.closest(excluded) ||
        end?.closest(excluded)
      ) {
        close();
        return;
      }
      const text = selected.toString().trim(),
        rect = range.getBoundingClientRect(),
        viewport = root.getBoundingClientRect();
      if (
        !text ||
        (!rect.width && !rect.height) ||
        rect.bottom <= Math.max(0, viewport.top) ||
        rect.top >= Math.min(window.innerHeight, viewport.bottom) ||
        rect.right <= Math.max(0, viewport.left) ||
        rect.left >= Math.min(window.innerWidth, viewport.right)
      ) {
        close();
        return;
      }
      setSnapshot({
        scopeKey,
        selection: {
          text,
          sourceKey: region.dataset.selectionKey ?? scopeKey,
          contentType: region.dataset.conversationSelectable as SelectionState["contentType"],
          path: region.dataset.selectionPath,
          sourceTitle:
            region.dataset.selectionTitle ??
            (
              { user: "用户消息", assistant: "助手消息", reasoning: "推理内容", tool: "工具结果" } as Record<
                string,
                string
              >
            )[region.dataset.conversationSelectable ?? ""],
          top: rect.top,
          bottom: rect.bottom,
          center: rect.left + rect.width / 2,
        },
      });
    };
    const schedule = (event: Event) => {
      const target = event.target instanceof Node ? element(event.target) : null;
      if (!target?.closest("[data-conversation-selectable]") || target.closest(excluded)) {
        close();
        return;
      }
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(inspect);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      else if (
        (event.shiftKey &&
          /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(event.key)) ||
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a")
      ) {
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(inspect);
      }
    };
    const changed = () => {
      if (window.getSelection()?.isCollapsed) close();
    };
    root.addEventListener("mouseup", schedule);
    root.addEventListener("touchend", schedule);
    root.addEventListener("scroll", close, true);
    document.addEventListener("pointerdown", leaveSelection, true);
    document.addEventListener("focusin", leaveSelection);
    document.addEventListener("keyup", key);
    document.addEventListener("selectionchange", changed);
    window.addEventListener("resize", close);
    window.addEventListener("blur", dismiss);
    return () => {
      cancelAnimationFrame(frame.current);
      root.removeEventListener("mouseup", schedule);
      root.removeEventListener("touchend", schedule);
      root.removeEventListener("scroll", close, true);
      document.removeEventListener("pointerdown", leaveSelection, true);
      document.removeEventListener("focusin", leaveSelection);
      document.removeEventListener("keyup", key);
      document.removeEventListener("selectionchange", changed);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", dismiss);
    };
  }, [rootRef, scopeKey, onAdd, close]);
  const state = snapshot?.scopeKey === scopeKey ? snapshot.selection : undefined;
  useLayoutEffect(() => {
    const element = menu.current;
    if (!state || !element) return;
    const position = () => {
      const rect = element.getBoundingClientRect();
      element.style.left = `${Math.max(12, Math.min(window.innerWidth - rect.width - 12, state.center - rect.width / 2))}px`;
      const top = state.top - rect.height - 8 >= 12 ? state.top - rect.height - 8 : state.bottom + 8;
      element.style.top = `${Math.max(12, Math.min(window.innerHeight - rect.height - 12, top))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    return () => observer.disconnect();
  }, [state]);
  return state && onAdd
    ? createPortal(
        <div
          role="toolbar"
          aria-label="选文操作"
          ref={menu}
          className="conversation-selection-menu"
          data-conversation-selection-tooltip="true"
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
        >
          {state.text.length > 8000 ? (
            <span>单条引用最多 8,000 个字符。</span>
          ) : (
            <button
              type="button"
              data-conversation-selection-action="add-to-task"
              onClick={() => {
                window.getSelection()?.removeAllRanges();
                onAdd({
                  id: crypto.randomUUID(),
                  text: state.text,
                  sourceKey: state.sourceKey,
                  contentType: state.contentType,
                  path: state.path,
                  sourceTitle: state.sourceTitle,
                });
                close();
              }}
            >
              添加到当前任务
            </button>
          )}
        </div>,
        document.body,
      )
    : null;
}
