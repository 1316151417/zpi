import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowUpFromLine, GripVertical, Pencil, Trash2 } from "lucide-react";
import { memo, useState } from "react";
import { type Mention, parseMentions } from "zpi-coding-agent/input";
import { type ConversationSelection, parseSelectionPrompt } from "../conversation-selections.ts";
import type { InputQueue, QueuedInput } from "../types.ts";
import { userErrorMessage } from "../user-error.ts";
import { SelectionReferenceChip } from "./ConversationSelections.tsx";
import { ActionHint } from "./MessageActions.tsx";

export interface QueueActions {
  remove(itemId: string): Promise<void>;
  edit(itemId: string): Promise<void>;
  sendNow(itemId: string): Promise<void>;
  move(itemId: string, beforeId: string | null): Promise<void>;
  resume(): Promise<void>;
}
const restrictQueueDragToPanel: Modifier = ({
  transform,
  draggingNodeRect,
  activeNodeRect,
  containerNodeRect,
  windowRect,
}) => {
  const node = draggingNodeRect ?? activeNodeRect,
    boundary = containerNodeRect ?? windowRect;
  return {
    ...transform,
    x: 0,
    y:
      node && boundary
        ? Math.min(Math.max(transform.y, boundary.top - node.top), boundary.bottom - node.bottom)
        : transform.y,
  };
};
// 排队行只展示可见正文与引用，不能把 userselect 传输格式当成用户文字。
const mentionMarkers: Partial<Record<Mention["kind"], string>> = { skill: "$", session: "#" };
function queuedContent(item: QueuedInput): {
  text: string;
  selections: ConversationSelection[];
  attachments: string[];
} {
  if (item.subagentNotification)
    return {
      text: `${item.subagentNotification.agentType} 已回传 · ${item.subagentNotification.description}`,
      selections: [],
      attachments: [],
    };
  const parsed = parseSelectionPrompt(item.text);
  let text = parsed.text;
  // 输入框与已发送消息用图标表达引用类型，排队行只有文字，必须补回 $ / # 标记。
  for (const mention of parseMentions(text).reverse())
    text =
      text.slice(0, mention.start) +
      (mentionMarkers[mention.kind] ?? "") +
      mention.label +
      text.slice(mention.end);
  const attachments = item.attachments.map((image) => image.name);
  return {
    // 图片名称单独成行；只有旧记录的纯文件引用才回退到正文位。
    text: text || (parsed.selections.length || attachments.length ? "" : item.fileReferences.join("、")),
    selections: parsed.selections,
    attachments,
  };
}
const QueueRow = memo(function QueueRow({
  item,
  index,
  pending,
  action,
  actions,
}: {
  item: QueuedInput;
  index: number;
  pending: boolean;
  action(itemId: string, work: () => Promise<void>): void;
  actions: QueueActions;
}) {
  const locked = pending || item.state !== "queued";
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, isDragging, transform, transition } =
    useSortable({ id: item.id, disabled: locked });
  const compact = /^\/compact(?:\s|$)/.test(item.text);
  const content = queuedContent(item);
  return (
    <li
      ref={setNodeRef}
      data-testid="queue-item"
      data-queue-item-id={item.id}
      data-index={index}
      data-dispatch-state={item.state}
      className={`queue-row${isDragging ? " dragging" : ""}${pending ? " pending" : ""}`}
      style={{
        transform: CSS.Transform.toString(transform ? { ...transform, scaleX: 1, scaleY: 1 } : null),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
    >
      <ActionHint label="拖拽排序" appearance="control">
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="queue-drag"
          aria-label="拖拽排序"
          disabled={locked}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={16} />
        </button>
      </ActionHint>
      <span
        className="queue-content"
        title={content.text || content.attachments.join("、") || item.fileReferences.join("、")}
      >
        {content.text && (
          <span className={`queue-text${compact ? " compact" : ""}`}>
            {compact ? "/compact" : content.text}
          </span>
        )}
        {content.selections.length > 0 && <SelectionReferenceChip references={content.selections} />}
        {content.attachments.length > 0 && (
          <span className="queue-attachments">{content.attachments.join("、")}</span>
        )}
      </span>
      <button
        type="button"
        className="queue-now"
        disabled={locked}
        onClick={() => action(item.id, () => actions.sendNow(item.id))}
      >
        <ArrowUpFromLine size={14} />
        立即
      </button>
      {!compact && !item.subagentNotification && (
        <ActionHint label="编辑" appearance="control">
          <button
            type="button"
            className="queue-icon"
            aria-label="编辑"
            disabled={locked}
            onClick={() => action(item.id, () => actions.edit(item.id))}
          >
            <Pencil size={16} />
          </button>
        </ActionHint>
      )}
      <ActionHint label="移除待发送消息" appearance="control">
        <button
          type="button"
          className="queue-icon"
          aria-label="移除待发送消息"
          disabled={locked}
          onClick={() => action(item.id, () => actions.remove(item.id))}
        >
          <Trash2 size={16} />
        </button>
      </ActionHint>
    </li>
  );
});
export const ConversationQueuePanel = memo(function ConversationQueuePanel({
  queue,
  actions,
  onError,
}: {
  queue: InputQueue;
  actions: QueueActions;
  onError(error: unknown): void;
}) {
  const [pending, setPending] = useState(new Set<string>());
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const action = (id: string, work: () => Promise<void>) => {
    setPending((old) => new Set(old).add(id));
    void work()
      .catch(onError)
      .finally(() =>
        setPending((old) => {
          const next = new Set(old);
          next.delete(id);
          return next;
        }),
      );
  };
  const move = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = queue.items.findIndex((item) => item.id === active.id),
      to = queue.items.findIndex((item) => item.id === over.id);
    if (from < 0 || to < 0) return;
    const remaining = queue.items.filter((item) => item.id !== active.id);
    const before =
      from < to
        ? (remaining[remaining.findIndex((item) => item.id === over.id) + 1]?.id ?? null)
        : String(over.id);
    action(String(active.id), () => actions.move(String(active.id), before));
  };
  if (!queue.items.length) return null;
  return (
    <section
      className="conversation-queue"
      data-testid="input-queue"
      aria-label={`待发送消息（${queue.items.length}）`}
    >
      {!queue.autoDrain && (
        <div className="queue-paused">
          <span>
            {queue.pauseReason === "stopped"
              ? "由于你中断了当前响应，队列已暂停"
              : queue.pauseReason === "error"
                ? "由于当前响应出错，队列已暂停（内容未丢失）"
                : "队列已暂停"}
          </span>
          <button
            type="button"
            aria-label="继续按顺序自动发送队列中的内容"
            disabled={pending.has("resume")}
            onClick={() => action("resume", actions.resume)}
          >
            继续
          </button>
        </div>
      )}
      {queue.error && (
        <small role="alert" className="queue-error">
          {userErrorMessage(queue.error)}
        </small>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictQueueDragToPanel]}
        onDragEnd={move}
      >
        <SortableContext items={queue.items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <ul>
            {queue.items.map((item, index) => (
              <QueueRow
                key={item.id}
                item={item}
                index={index}
                pending={pending.has(item.id)}
                action={action}
                actions={actions}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </section>
  );
});
