// UI adapted from ZCode workspace-grouped-tasks (Apache-2.0), aac4755666.
import {
  closestCenter,
  DndContext,
  type DragMoveEvent,
  type DragOverEvent,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import * as Context from "@radix-ui/react-context-menu";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Hash,
  Maximize2,
  MessageCirclePlus,
  Minimize2,
} from "lucide-react";
import { type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActionHint } from "zpi-ui";
import type { SessionRecord } from "../shared/bridge.ts";
import {
  applyTaskGroupCommand,
  type TaskGroup,
  type TaskGroupCommand,
  type TaskGroupNode,
  type TaskGroupState,
  taskGroupColors,
  taskGroupFor,
} from "../shared/task-groups.ts";
import { changeTaskGroups, newSession, report, useStore } from "./store.ts";
import { TaskGroupRow } from "./TaskGroupRow.tsx";
import { TaskGroupVirtualList } from "./TaskGroupVirtualList.tsx";
import { groupColorLabels, TaskGroupColorMark } from "./task-group-colors.tsx";
import {
  canStartTaskGroupDrag,
  type GroupDropTarget,
  type TaskGroupDragMotion,
  taskGroupDragEvent,
  taskGroupRowDragProps,
} from "./task-group-drag.ts";

import {
  expandTaskGroup,
  parseCollapsedTaskGroups,
  pruneCollapsedTaskGroups,
  taskGroupCollapsedKey,
} from "./task-group-expansion.ts";

function readCollapsed(): string[] {
  try {
    return parseCollapsedTaskGroups(localStorage.getItem(taskGroupCollapsedKey));
  } catch {
    return [];
  }
}
export function useTaskGroupExpansion(groupIds: string[], hydrated = true) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const key = groupIds.join(":");
  useEffect(() => {
    if (!hydrated) return;
    setCollapsed((current) => {
      return pruneCollapsedTaskGroups(current, groupIds, hydrated);
    });
  }, [key, hydrated]);
  useEffect(() => {
    try {
      localStorage.setItem(taskGroupCollapsedKey, JSON.stringify(collapsed));
    } catch {}
  }, [collapsed]);
  return { collapsed, setCollapsed };
}
export function TaskGroupToolbar({
  state,
  collapsed,
  onToggleAll,
  onCreate,
}: {
  state: TaskGroupState;
  collapsed: string[];
  onToggleAll(): void;
  onCreate(): void;
}) {
  const hasGroups = state.groups.length > 0;
  const allExpanded = hasGroups && state.groups.every((group) => !collapsed.includes(group.id));
  const toggleLabel = allExpanded ? "收起全部" : "展开全部";
  return (
    <>
      {/* 空组仍保留切换器旁的入口，避免分组/项目切换时箭头消失；无目标时禁用。 */}
      <ActionHint label={toggleLabel} appearance="control">
        <button
          className="task-group-toggle"
          aria-label={toggleLabel}
          disabled={!hasGroups}
          onClick={onToggleAll}
        >
          {allExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </ActionHint>
      <ActionHint label="新建分组" appearance="control">
        <button className="task-group-create task-group-toggle" aria-label="新建分组" onClick={onCreate}>
          <Hash size={14} />
        </button>
      </ActionHint>
    </>
  );
}
class GroupPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: PointerEvent) => {
        const control =
          nativeEvent.target instanceof Element
            ? nativeEvent.target.closest("button,input,textarea,[role=menu]")
            : null;
        return canStartTaskGroupDrag(nativeEvent, Boolean(control), control?.hasAttribute("data-group-drag"));
      },
    },
  ];
}
function DropZone({
  groupId,
  empty,
  onCreate,
  disabled = false,
}: {
  groupId: string;
  empty?: boolean;
  onCreate(): void;
  disabled?: boolean;
}) {
  const drop = useDroppable({
    disabled,
    id: `${empty ? "empty" : "footer"}:${groupId}`,
    data: { type: empty ? "empty" : "footer", id: groupId },
  });
  return empty ? (
    <button
      ref={drop.setNodeRef}
      className="task-group-empty"
      data-grouped-empty-drop-zone-id={groupId}
      onClick={onCreate}
    >
      <MessageCirclePlus size={14} />
      新建任务，或拖拽到这里。
    </button>
  ) : (
    <div ref={drop.setNodeRef} className="task-group-footer-drop" />
  );
}
function GroupItem({
  group,
  tasks,
  state,
  selected,
  collapsed,
  onToggle,
  onExpand,
  newGroup,
  onSetup,
  dragging,
}: {
  group: TaskGroup;
  tasks: SessionRecord[];
  state: TaskGroupState;
  selected?: string;
  collapsed: boolean;
  onToggle(): void;
  onExpand(): void;
  newGroup: boolean;
  onSetup(): void;
  dragging?: TaskGroupNode;
}) {
  const section = useRef<HTMLElement>(null);
  const [renderContent, setRenderContent] = useState(!collapsed);
  useEffect(() => {
    if (!collapsed) {
      setRenderContent(true);
      return;
    }
    const timer = window.setTimeout(() => setRenderContent(false), 180);
    return () => window.clearTimeout(timer);
  }, [collapsed]);
  const [sticky, setSticky] = useState(false);
  useLayoutEffect(() => {
    const element = section.current;
    const scroll = element?.closest<HTMLElement>(".sidebar-sections");
    if (!element || !scroll) return;
    const update = () => {
      const top = scroll.getBoundingClientRect().top + 4;
      const bounds = element.getBoundingClientRect();
      setSticky(!collapsed && !dragging && bounds.top + 10 < top && bounds.bottom > top + 32);
    };
    update();
    scroll.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      scroll.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [collapsed, Boolean(dragging)]);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(group.title);
  const [colorOpen, setColorOpen] = useState(false);
  const pendingRename = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const initialSetup = useRef(false);
  const colorMenu = useRef<HTMLDivElement>(null);
  const draggable = useDraggable({
    id: `group:${group.id}`,
    disabled: renaming,
    data: { type: "group", id: group.id },
  });
  const headerDrop = useDroppable({
    id: `header:${group.id}`,
    data: { type: collapsed ? "collapsed" : "header", id: group.id },
  });
  const run = (command: TaskGroupCommand) => void changeTaskGroups(command).catch(report);
  const createTask = () => {
    onExpand();
    void newSession(undefined, group.id).catch(report);
  };
  useEffect(() => {
    if (newGroup) {
      initialSetup.current = true;
      setName(group.title);
      setRenaming(true);
      setColorOpen(true);
      onSetup();
    }
  }, [newGroup]);
  useEffect(() => {
    if (renaming) {
      input.current?.focus();
      input.current?.select();
    }
  }, [renaming]);
  const commit = () => {
    if (!renaming) return;
    setRenaming(false);
    if (name.trim() && name.trim() !== group.title) run({ type: "rename", id: group.id, title: name.trim() });
  };
  return (
    <section
      ref={section}
      className="task-group"
      data-grouped-group-item-id={group.id}
      data-group-color={group.color}
      data-group-collapsed={collapsed}
    >
      <Context.Root>
        <Context.Trigger asChild>
          {/* biome-ignore lint/a11y/useSemanticElements: Group header contains color, title, and new-task controls. */}
          <div
            ref={(element) => {
              draggable.setNodeRef(element);
              headerDrop.setNodeRef(element);
            }}
            {...draggable.attributes}
            {...draggable.listeners}
            className={`task-group-header${sticky ? " task-group-header-sticky" : ""}`}
            role="button"
            tabIndex={0}
            data-grouped-group-header-id={group.id}
            aria-label={`分组 ${group.title}`}
            aria-expanded={!collapsed}
            data-dragging={dragging?.type === "group" && dragging.id === group.id}
            onClick={onToggle}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                onToggle();
              }
            }}
          >
            <Menu.Root open={colorOpen} onOpenChange={setColorOpen} modal={false}>
              <Menu.Trigger
                className="task-group-color-trigger"
                aria-label={`分组颜色 ${group.title}`}
                onClick={(event) => event.stopPropagation()}
              >
                <TaskGroupColorMark color={group.color} />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content
                  ref={colorMenu}
                  className="parity-menu task-group-color-menu"
                  onFocusCapture={() => {
                    if (initialSetup.current) input.current?.focus();
                  }}
                  onPointerDownCapture={() => {
                    initialSetup.current = false;
                  }}
                  onKeyDownCapture={() => {
                    initialSetup.current = false;
                  }}
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  align="start"
                  sideOffset={4}
                  onCloseAutoFocus={(event) => event.preventDefault()}
                  onFocusOutside={(event) => {
                    if (event.target === input.current) event.preventDefault();
                  }}
                >
                  <Menu.Label className="parity-menu-label">分组颜色</Menu.Label>
                  <Menu.RadioGroup
                    value={group.color}
                    onValueChange={(color) =>
                      run({ type: "color", id: group.id, color: color as TaskGroup["color"] })
                    }
                  >
                    {taskGroupColors.map((color) => (
                      <Menu.RadioItem key={color} value={color} className="parity-menu-radio">
                        <TaskGroupColorMark color={color} dot />
                        {groupColorLabels[color]}
                        <Menu.ItemIndicator className="parity-menu-indicator">
                          <Check size={14} />
                        </Menu.ItemIndicator>
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
            <div className="task-group-title-wrap">
              {renaming ? (
                <label className="task-group-name-editor">
                  <span className="task-group-name-measure" aria-hidden="true">
                    {name || group.title}
                  </span>
                  <input
                    ref={input}
                    aria-label="重命名分组"
                    className="task-group-name-input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={(event) => {
                      if (
                        initialSetup.current &&
                        colorMenu.current?.contains(event.relatedTarget as Node | null)
                      ) {
                        input.current?.focus();
                        return;
                      }
                      initialSetup.current = false;
                      commit();
                    }}
                    onCompositionStart={() => {
                      composing.current = true;
                    }}
                    onCompositionEnd={() => {
                      composing.current = false;
                    }}
                    onKeyDown={(event) => {
                      initialSetup.current = false;
                      event.stopPropagation();
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setRenaming(false);
                        setColorOpen(false);
                      } else if (
                        event.key === "Enter" &&
                        !event.nativeEvent.isComposing &&
                        !composing.current &&
                        event.keyCode !== 229
                      )
                        event.currentTarget.blur();
                    }}
                  />
                </label>
              ) : (
                <button className="task-group-title" data-group-drag title={group.title}>
                  {group.title}
                </button>
              )}
              {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </div>
            <span className="task-group-count">{tasks.length}</span>
            <ActionHint label="新建任务" appearance="control" open={dragging ? false : undefined}>
              <button
                className="task-group-new-task"
                aria-label={`新建任务 ${group.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  createTask();
                }}
              >
                <MessageCirclePlus size={14} />
              </button>
            </ActionHint>
          </div>
        </Context.Trigger>
        <Context.Portal>
          <Context.Content
            className="parity-menu task-group-context-menu"
            onCloseAutoFocus={(event) => {
              if (pendingRename.current) {
                event.preventDefault();
                pendingRename.current = false;
                setName(group.title);
                setRenaming(true);
              }
            }}
          >
            <Context.Item className="menu-item" onSelect={createTask}>
              新建任务
            </Context.Item>
            <Context.Separator className="menu-separator" />
            {!sticky && (
              <Context.Item
                className="menu-item"
                onSelect={() => {
                  pendingRename.current = true;
                }}
              >
                重命名
              </Context.Item>
            )}
            <Context.Sub>
              <Context.SubTrigger className="menu-item">
                更改颜色
                <ChevronRight size={14} className="menu-sub-arrow" />
              </Context.SubTrigger>
              <Context.Portal>
                <Context.SubContent className="parity-menu task-group-color-menu">
                  {taskGroupColors.map((color) => (
                    <Context.Item
                      key={color}
                      className="menu-item"
                      onSelect={() => run({ type: "color", id: group.id, color })}
                    >
                      <TaskGroupColorMark color={color} dot />
                      {groupColorLabels[color]}
                    </Context.Item>
                  ))}
                </Context.SubContent>
              </Context.Portal>
            </Context.Sub>
            <Context.Separator className="menu-separator" />
            <Context.Item className="menu-item" onSelect={() => run({ type: "delete", id: group.id })}>
              取消分组并删除
            </Context.Item>
          </Context.Content>
        </Context.Portal>
      </Context.Root>
      <div
        className="task-group-body-grid"
        data-collapsed={collapsed}
        aria-hidden={collapsed}
        inert={collapsed}
      >
        <div className="task-group-body">
          {renderContent && (
            <>
              <div className="task-group-content">
                {tasks
                  .filter((record) => record.draft)
                  .map((record) => (
                    <TaskGroupRow key={record.id} record={record} state={state} selected={selected} />
                  ))}
                {tasks.some((record) => !record.draft) ? (
                  <TaskGroupVirtualList
                    items={tasks.filter((record) => !record.draft)}
                    itemKey={(record) => record.id}
                    estimate={() => 32}
                    renderItem={(record) => (
                      <TaskGroupRow
                        key={record.id}
                        record={record}
                        state={state}
                        selected={selected}
                        {...taskGroupRowDragProps(dragging, record.id, collapsed)}
                      />
                    )}
                  />
                ) : !tasks.length ? (
                  <DropZone groupId={group.id} empty onCreate={createTask} disabled={collapsed} />
                ) : null}
              </div>
              <DropZone groupId={group.id} onCreate={createTask} disabled={collapsed} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
export function TaskGroups({
  state,
  records,
  selected,
  collapsed,
  setCollapsed,
  newGroupId,
  onSetup,
}: {
  state: TaskGroupState;
  records: SessionRecord[];
  selected?: string;
  collapsed: string[];
  setCollapsed(value: string[] | ((current: string[]) => string[])): void;
  newGroupId?: string;
  onSetup(): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const previousRects = useRef<Map<string, number>>(new Map());
  const [dragging, setDragging] = useState<TaskGroupNode>();
  const [preview, setPreview] = useState<TaskGroupState>();
  const lastCommand = useRef<TaskGroupCommand | undefined>(undefined);
  const origin = useRef(state);
  const motion = useRef<TaskGroupDragMotion>({ deltaY: 0, position: "after" });
  const sensors = useSensors(useSensor(GroupPointerSensor, { activationConstraint: { distance: 6 } }));
  const display = preview ?? state;
  const allSessions = useStore((store) => store.sessions);
  const draft = selected ? allSessions.get(selected) : undefined;
  const rootDraft =
    draft?.draft && !draft.parentSessionId && !taskGroupFor(state, draft.id) ? draft : undefined;
  useEffect(() => {
    if (rootDraft) {
      const scroll = list.current?.closest<HTMLElement>(".sidebar-sections");
      if (scroll) scroll.scrollTop = 0;
    }
  }, [rootDraft?.id]);
  const rows = new Map(
    [...records, ...(draft?.draft && !draft.parentSessionId ? [draft] : [])]
      .filter((record) => record.pinnedAt == null && record.archivedAt == null)
      .map((record) => [record.id, record]),
  );
  const rememberRects = () => {
    previousRects.current = new Map(
      Array.from(
        list.current?.querySelectorAll<HTMLElement>("[data-task-item-key],[data-grouped-group-header-id]") ??
          [],
      ).map((element) => [
        element.dataset.taskItemKey
          ? `task:${element.dataset.taskItemKey}`
          : `group:${element.dataset.groupedGroupHeaderId}`,
        element.getBoundingClientRect().top,
      ]),
    );
  };
  useLayoutEffect(() => {
    if (!previousRects.current.size || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const element of list.current?.querySelectorAll<HTMLElement>(
      "[data-task-item-key],[data-grouped-group-header-id]",
    ) ?? []) {
      const key = element.dataset.taskItemKey
        ? `task:${element.dataset.taskItemKey}`
        : `group:${element.dataset.groupedGroupHeaderId}`;
      const before = previousRects.current.get(key);
      const delta = before === undefined ? 0 : before - element.getBoundingClientRect().top;
      if (delta && element.dataset.dragging !== "true")
        element.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
          duration: 150,
          easing: "cubic-bezier(0.2,0,0,1)",
        });
    }
    previousRects.current.clear();
  }, [preview]);
  const onDragEvent = (event: DragOverEvent | DragMoveEvent) => {
    const active = event.active.data.current as TaskGroupNode | undefined;
    const target = event.over?.data.current as GroupDropTarget | undefined;
    if (!active) return;
    const result = taskGroupDragEvent(origin.current, active, motion.current, event.delta.y, target);
    motion.current = result.motion;
    if (!target) {
      motion.current.target = undefined;
      return;
    }
    if (result.command && JSON.stringify(result.command) !== JSON.stringify(lastCommand.current)) {
      rememberRects();
      lastCommand.current = result.command;
      setPreview(applyTaskGroupCommand(origin.current, result.command));
    }
  };
  const overlayRecord = dragging?.type === "task" ? rows.get(dragging.id) : undefined;
  const overlayGroup =
    dragging?.type === "group" ? state.groups.find((group) => group.id === dragging.id) : undefined;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      autoScroll={{ threshold: { x: 0.1, y: 0.1 } }}
      onDragStart={({ active }) => {
        origin.current = state;
        motion.current = { deltaY: 0, position: "after" };
        lastCommand.current = undefined;
        setDragging(active.data.current as TaskGroupNode);
      }}
      onDragOver={onDragEvent}
      onDragMove={onDragEvent}
      onDragCancel={() => {
        setPreview(undefined);
        setDragging(undefined);
        lastCommand.current = undefined;
      }}
      onDragEnd={({ over }) => {
        const command = over ? lastCommand.current : undefined;
        setPreview(undefined);
        setDragging(undefined);
        lastCommand.current = undefined;
        if (command) void changeTaskGroups(command).catch(report);
      }}
    >
      <div ref={list} className="task-groups" data-drag-active={Boolean(dragging)}>
        {rootDraft && <TaskGroupRow record={rootDraft} state={display} selected={selected} />}
        <TaskGroupVirtualList
          items={display.roots.filter(
            (node) => node.type === "group" || (rows.has(node.id) && node.id !== rootDraft?.id),
          )}
          itemKey={(node) => `${node.type}:${node.id}`}
          estimate={(node) =>
            node.type === "task"
              ? 32
              : collapsed.includes(node.id)
                ? 44
                : 54 + Math.max(1, display.members[node.id]?.filter((id) => rows.has(id)).length ?? 0) * 32
          }
          renderItem={(node) => {
            if (node.type === "task") {
              const record = rows.get(node.id);
              return record ? (
                <TaskGroupRow
                  key={`task:${node.id}`}
                  record={record}
                  state={display}
                  selected={selected}
                  {...taskGroupRowDragProps(dragging, record.id)}
                />
              ) : null;
            }
            const group = display.groups.find((entry) => entry.id === node.id);
            if (!group) return null;
            return (
              <GroupItem
                key={`group:${group.id}`}
                group={group}
                state={display}
                tasks={(display.members[group.id] ?? []).flatMap((id) => rows.get(id) ?? [])}
                selected={selected}
                collapsed={
                  collapsed.includes(group.id) || (dragging?.type === "group" && dragging.id === group.id)
                }
                onToggle={() =>
                  setCollapsed((current) =>
                    current.includes(group.id)
                      ? current.filter((id) => id !== group.id)
                      : [...current, group.id],
                  )
                }
                onExpand={() => setCollapsed((current) => expandTaskGroup(current, group.id))}
                newGroup={group.id === newGroupId}
                onSetup={onSetup}
                dragging={dragging}
              />
            );
          }}
        />
        {!display.roots.length && <div className="task-list-empty">还没有任务</div>}
      </div>
      {createPortal(
        <DragOverlay dropAnimation={{ duration: 150, easing: "cubic-bezier(0.2,0,0,1)" }}>
          {overlayRecord ? (
            <TaskGroupRow record={overlayRecord} state={state} overlay />
          ) : overlayGroup ? (
            <div className="task-group-header task-group-drag-overlay">
              <TaskGroupColorMark color={overlayGroup.color} />
              <span className="task-group-overlay-title">{overlayGroup.title}</span>
              <span className="task-group-count">
                {(state.members[overlayGroup.id] ?? []).filter((id) => rows.has(id)).length}
              </span>
            </div>
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
