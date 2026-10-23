import { closestCenter, DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as Context from "@radix-ui/react-context-menu";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PaneTabIcon } from "./PaneTabIcon.tsx";
import {
  activatePaneTab,
  closePaneTabs,
  closeTab,
  type PaneTab,
  paneTask,
  reorderPaneTab,
} from "./pane-store.ts";

export function PaneTabs({
  tabs,
  active,
  children,
}: {
  tabs: PaneTab[];
  active?: string;
  children?: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingTab = tabs.find((tab) => tab.id === draggingId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  useEffect(() => {
    viewport.current
      ?.querySelector<HTMLElement>(".pane-tab.selected")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <DndContext
      sensors={sensors}
      // 与 ZCode 一致，按中心距离预览横向排序；指针离开 tab 栏后仍能换位。
      collisionDetection={closestCenter}
      onDragStart={({ active }) => setDraggingId(String(active.id))}
      onDragCancel={() => setDraggingId(null)}
      onDragEnd={({ active, over }) => {
        setDraggingId(null);
        if (over) reorderPaneTab(String(active.id), String(over.id));
      }}
    >
      <div ref={viewport} role="tablist" aria-label="侧栏标签" className="pane-tabs">
        {children}
        <SortableContext items={tabs.map((tab) => tab.id)} strategy={horizontalListSortingStrategy}>
          {tabs.map((tab, index) => (
            <SortablePaneTab
              key={tab.id}
              tab={tab}
              active={active === tab.id}
              canCloseOthers={tabs.length > 1}
              onNavigate={(direction) => {
                const next = tabs[(index + direction + tabs.length) % tabs.length];
                if (next) activatePaneTab(next.id);
              }}
            />
          ))}
        </SortableContext>
      </div>
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {draggingTab && (
            <div className="pane-tab-drag-overlay" aria-hidden="true">
              <PaneTabContent tab={draggingTab} />
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

function SortablePaneTab({
  tab,
  active,
  canCloseOthers,
  onNavigate,
}: {
  tab: PaneTab;
  active: boolean;
  canCloseOthers: boolean;
  onNavigate: (direction: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  const wasDragging = useRef(false);
  if (isDragging) wasDragging.current = true;

  return (
    <Context.Root>
      <Context.Trigger asChild>
        <div
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          role="tab"
          aria-label={tab.title}
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          title={isDragging ? undefined : tab.title}
          className={`pane-tab ${active ? "selected" : ""}`}
          data-dragging={isDragging || undefined}
          style={{
            transform: CSS.Transform.toString(transform ? { ...transform, scaleX: 1, scaleY: 1 } : null),
            transition,
            zIndex: isDragging ? 10 : undefined,
            opacity: isDragging ? 0.85 : 1,
          }}
          onPointerDown={(event) => {
            wasDragging.current = false;
            listeners?.onPointerDown?.(event);
            event.preventDefault();
          }}
          onClick={(event) => {
            if (event.button === 1 || wasDragging.current) {
              wasDragging.current = false;
              event.preventDefault();
              return;
            }
            activatePaneTab(tab.id);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Delete") {
              event.preventDefault();
              paneTask(closeTab(tab.id));
            } else if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
              event.preventDefault();
              onNavigate(event.key === "ArrowRight" ? 1 : -1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              activatePaneTab(tab.id);
            }
          }}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              event.stopPropagation();
              paneTask(closeTab(tab.id));
            }
          }}
        >
          <span className="pane-tab-trigger">
            <PaneTabContent tab={tab} />
          </span>
          <button
            className="tab-close"
            aria-label={`关闭标签 ${tab.title}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              paneTask(closeTab(tab.id));
            }}
          >
            <X size={12} />
          </button>
        </div>
      </Context.Trigger>
      <Context.Portal>
        <Context.Content className="parity-menu pane-tab-menu">
          <Context.Item className="parity-menu-item" onSelect={() => paneTask(closeTab(tab.id))}>
            关闭标签
          </Context.Item>
          <Context.Item
            className="parity-menu-item"
            disabled={!canCloseOthers}
            onSelect={() => paneTask(closePaneTabs(tab.id))}
          >
            关闭其他标签
          </Context.Item>
          <Context.Item className="parity-menu-item" onSelect={() => paneTask(closePaneTabs())}>
            关闭所有标签
          </Context.Item>
        </Context.Content>
      </Context.Portal>
    </Context.Root>
  );
}

function PaneTabContent({ tab }: { tab: PaneTab }) {
  return (
    <span className="pane-tab-content">
      <span className="pane-tab-icon">
        <PaneTabIcon tab={tab} />
      </span>
      <span className="pane-tab-title">{tab.title}</span>
      {tab.type === "changes" && !tab.reviewSource && <span className="pane-tab-diff-badge">Diff</span>}
    </span>
  );
}
