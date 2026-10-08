import { parseMentions } from "ZPI-coding-agent/input";
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
import type { InputQueue, QueuedInput } from "../types.ts";
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
function displayText(item: QueuedInput) {
  let text = item.text;
  for (const mention of parseMentions(text).reverse())
    text = text.slice(0, mention.start) + mention.label + text.slice(mention.end);
  return text || item.attachments.map((image) => image.name).join("、") || item.fileReferences.join("、");
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
      <span className={`queue-text${compact ? " compact" : ""}`} title={item.text}>
        {compact ? "/compact" : displayText(item)}
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
      {!compact && (
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
          {queue.error}
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
