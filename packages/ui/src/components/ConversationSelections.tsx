// Adapted from ZCode selection guard/menu and ContextAttachmentPill (Apache-2.0).
import * as HoverCard from "@radix-ui/react-hover-card";
import * as Popover from "@radix-ui/react-popover";
import { Code2, MessageSquareText, Quote, Trash2, X } from "lucide-react";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ConversationSelection, getFileCommentSelection } from "../conversation-selections.ts";
import type { FileLocation } from "../link-target.ts";

interface SelectionReferenceChipProps {
  references: ConversationSelection[];
  onChange?: (value: ConversationSelection[]) => void;
  onFile?: (path: string, location?: FileLocation) => void;
  onCommentsEmpty?: () => void;
}
export function SelectionReferenceChip({
  references,
  onChange,
  onFile,
  onCommentsEmpty,
}: SelectionReferenceChipProps) {
  const comments = references.filter((reference) => getFileCommentSelection(reference));
  const quotes = references.filter((reference) => !getFileCommentSelection(reference));
  const changeGroup = (group: ConversationSelection[]) =>
    onChange
      ? (remaining: ConversationSelection[]) => {
          onChange(references.filter((item) => !group.includes(item) || remaining.includes(item)));
          if (group === comments && !remaining.length) onCommentsEmpty?.();
        }
      : undefined;
  return (
    <>
      <SelectionGroupChip references={comments} onChange={changeGroup(comments)} onFile={onFile} comments />
      <SelectionGroupChip references={quotes} onChange={changeGroup(quotes)} />
    </>
  );
}
export function SelectionReferenceDetails({
  references,
  onChange,
  onFile,
  comments = false,
}: SelectionReferenceChipProps & { comments?: boolean }) {
  return (
    <>
      {references.map((reference, index) => {
        const comment = comments ? getFileCommentSelection(reference) : null;
        const content = comment ? (
          <>
            <div className="file-comment-heading">
              <strong>{comment.title}</strong>
              <span>{comment.lineLabel}</span>
            </div>
            <small title={comment.path}>{comment.path}</small>
            {comment.comment.trim() && <p>{comment.comment}</p>}
          </>
        ) : (
          <>
            <p>{reference.text}</p>
            {(reference.path || reference.sourceTitle) && (
              <small>{reference.path || reference.sourceTitle}</small>
            )}
          </>
        );
        return (
          <div
            className={`selection-reference-detail${comment ? " file-comment-detail" : ""}`}
            key={reference.id ?? index}
          >
            {comment ? <Code2 size={16} /> : <Quote size={16} />}
            {comment && onFile ? (
              <button
                type="button"
                className="file-comment-source"
                aria-label={`打开 ${comment.title} ${comment.lineLabel}`}
                onClick={() => onFile(comment.path, { line: comment.start, endLine: comment.end })}
              >
                {content}
              </button>
            ) : (
              <div>{content}</div>
            )}
            {onChange && (
              <button
                type="button"
                className="selection-remove-one"
                aria-label={comment ? "移除评论" : "移除对话引用"}
                onClick={(event) => {
                  event.stopPropagation();
                  onChange(references.filter((_, i) => i !== index));
                }}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}
function SelectionGroupChip({
  references,
  onChange,
  onFile,
  comments = false,
}: SelectionReferenceChipProps & { comments?: boolean }) {
  const [open, setOpen] = useState(false);
  const interactive = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => clearTimeout(closeTimer.current);
  const hover = () => {
    cancelClose();
    if (!open) interactive.current = false;
    setOpen(true);
  };
  const leave = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!interactive.current) setOpen(false);
    }, 100);
  };
  const activate = () => {
    cancelClose();
    if (open && interactive.current) {
      setOpen(false);
      return;
    }
    interactive.current = true;
    setOpen(true);
    // Hover may already have mounted the popover without moving focus.
    content.current?.querySelector<HTMLElement>("button:not(:disabled),[tabindex='0']")?.focus();
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!references.length) setOpen(false);
  }, [references.length]);
  if (!references.length) return null;
  const label = comments
    ? `${references.length} 条评论`
    : references.length === 1 && references[0].path
      ? `${references[0].path.split(/[\\/]/).pop()} · 引用`
      : `${references.length} 条${references.some((ref) => ref.path) ? "引用" : "对话引用"}`;
  const Card = comments ? Popover : HoverCard;
  return (
    <Card.Root open={open} onOpenChange={setOpen} {...(!comments ? { openDelay: 0, closeDelay: 0 } : {})}>
      <Card.Trigger asChild>
        {/* biome-ignore lint/a11y/useSemanticElements: Focusable pill with a separate remove button, matching ZCode. */}
        <div
          className="selection-reference-chip"
          role="button"
          tabIndex={0}
          aria-label={label}
          data-conversation-selection-reference-count={comments ? undefined : references.length}
          data-file-comment-count={comments ? references.length : undefined}
          onPointerEnter={(event) => {
            if (comments && event.pointerType !== "touch") hover();
          }}
          onPointerLeave={comments ? leave : undefined}
          onClick={(event) => {
            if (comments) {
              event.preventDefault();
              activate();
            } else setOpen((value) => !value);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (comments) activate();
              else setOpen((value) => !value);
            } else if (event.key === "Escape") setOpen(false);
          }}
        >
          {comments ? <MessageSquareText size={16} /> : <Quote size={16} />}
          <span>{label}</span>
          {onChange && (
            <button
              type="button"
              className="selection-remove-all"
              aria-label={comments ? "移除全部评论" : "移除对话引用"}
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
      </Card.Trigger>
      <Card.Portal>
        <Card.Content
          ref={content}
          onPointerEnter={comments ? cancelClose : undefined}
          onPointerLeave={comments ? leave : undefined}
          {...(comments
            ? {
                onFocusCapture: () => {
                  interactive.current = true;
                },
                onOpenAutoFocus: (event: Event) => {
                  if (!interactive.current) event.preventDefault();
                },
                onCloseAutoFocus: (event: Event) => {
                  if (!interactive.current) event.preventDefault();
                },
              }
            : {})}
          role="dialog"
          aria-label={comments ? "评论内容" : "引用内容"}
          className="selection-reference-popover"
          side="top"
          sideOffset={4}
          align={onChange ? "start" : "end"}
          collisionPadding={12}
        >
          <SelectionReferenceDetails
            references={references}
            onChange={
              onChange && comments
                ? (remaining) => {
                    setOpen(false);
                    onChange(remaining);
                  }
                : onChange
            }
            onFile={onFile}
            comments={comments}
          />
        </Card.Content>
      </Card.Portal>
    </Card.Root>
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
  addLabel = "添加到当前任务",
  onSideChat,
  sideChatDisabled,
  sideChatDisabledTitle = "请先处理辅助对话中的待处理请求。",
}: {
  rootRef: RefObject<HTMLElement | null>;
  scopeKey: string;
  onAdd?: (reference: ConversationSelection) => void;
  addLabel?: string;
  onSideChat?: (reference: ConversationSelection) => void;
  sideChatDisabled?: boolean;
  sideChatDisabledTitle?: string;
}) {
  const [snapshot, setSnapshot] = useState<{ scopeKey: string; selection: SelectionState }>();
  const menu = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  // Streaming can replace the action callback without changing selection availability or scope.
  const enabled = Boolean(onAdd);
  const close = useCallback(() => {
    cancelAnimationFrame(frame.current);
    setSnapshot(undefined);
  }, []);
  useEffect(() => {
    close();
    const root = rootRef.current;
    if (!root || !enabled) return;
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
    // Scrolling must follow the selection instead of closing: streaming
    // stick-to-bottom fires scroll events while the user is still reading.
    const followScroll = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(inspect);
    };
    root.addEventListener("mouseup", schedule);
    root.addEventListener("touchend", schedule);
    root.addEventListener("scroll", followScroll, true);
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
      root.removeEventListener("scroll", followScroll, true);
      document.removeEventListener("pointerdown", leaveSelection, true);
      document.removeEventListener("focusin", leaveSelection);
      document.removeEventListener("keyup", key);
      document.removeEventListener("selectionchange", changed);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", dismiss);
    };
  }, [rootRef, scopeKey, enabled, close]);
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
              {addLabel}
            </button>
          )}
          {onSideChat && state.text.length <= 8000 && (
            <>
              <div className="conversation-selection-divider" aria-hidden="true" />
              <button
                type="button"
                data-conversation-selection-action="ask-in-side-chat"
                disabled={sideChatDisabled}
                title={sideChatDisabled ? sideChatDisabledTitle : undefined}
                onClick={() => {
                  window.getSelection()?.removeAllRanges();
                  onSideChat({
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
                在辅助对话中提问
              </button>
            </>
          )}
        </div>,
        document.body,
      )
    : null;
}
