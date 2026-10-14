import { useDraggable, useDroppable } from "@dnd-kit/core";
import * as Context from "@radix-ui/react-context-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ArrowUpToLine, ChevronRight, Folder, LoaderIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ActionHint, TaskTitleOverflowText } from "zpi-ui";
import type { SessionRecord } from "../shared/bridge.ts";
import { orderedTaskGroups, type TaskGroupState, taskGroupFor } from "../shared/task-groups.ts";
import { deleteSessionWithPanes } from "./pane-store.ts";
import { QuestionBadge } from "./SidebarTaskRow.tsx";
import { formatTaskRelativeTime } from "./sidebar-task-model.ts";
import {
  archiveSession,
  changeTaskGroups,
  forgetDiscardedDraft,
  prepareDiscardDraft,
  refresh,
  report,
  selectSession,
  unwrap,
} from "./store.ts";
import { TaskGroupColorMark } from "./task-group-colors.tsx";
import { refreshTaskGroupChangeSummary } from "./task-group-tooltip.ts";

export function TaskGroupRow({
  record,
  state,
  selected,
  dragging = false,
  overlay = false,
  tooltipsDisabled = false,
  interactionDisabled = false,
}: {
  record: SessionRecord;
  state: TaskGroupState;
  selected?: string;
  dragging?: boolean;
  overlay?: boolean;
  tooltipsDisabled?: boolean;
  interactionDisabled?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [changes, setChanges] = useState<{ added: number; removed: number }>();
  const changeRequest = useRef(false);
  const workspaceLabel = record.cwd?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "ZPI";
  const changeRevision = useRef(record.updatedAt);
  changeRevision.current = record.updatedAt;
  const loadChanges = () => {
    if (record.draft) return;
    const revision = record.updatedAt;
    setChanges(undefined);
    void refreshTaskGroupChangeSummary(
      changeRequest,
      () => window.zpi.getTaskSearchChanges(record.id).then(unwrap),
      (summary) => {
        if (revision === changeRevision.current) setChanges(summary);
      },
    ).catch(() => {});
  };
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(record.title);
  const input = useRef<HTMLInputElement>(null);
  const pendingRename = useRef(false);
  const composing = useRef(false);
  const draggable = useDraggable({
    id: `task:${record.id}`,
    disabled: interactionDisabled || overlay || menuOpen || renaming || Boolean(record.draft),
    data: { type: "task", id: record.id },
  });
  const droppable = useDroppable({
    id: `task:${record.id}`,
    disabled: interactionDisabled || overlay || Boolean(record.draft),
    data: { type: "task", id: record.id },
  });
  const groupId = taskGroupFor(state, record.id);
  const run = (work: () => Promise<unknown>) => void work().catch(report);
  const moveTop = () => run(() => changeTaskGroups({ type: "taskTop", id: record.id }));
  const close = () => run(() => archiveSession(record.id));
  useEffect(() => {
    if (renaming) {
      input.current?.focus();
      input.current?.select();
    }
  }, [renaming]);
  const commitRename = () => {
    if (!renaming) return;
    setRenaming(false);
    if (title.trim() && title.trim() !== record.title)
      run(async () => {
        unwrap(await window.zpi.renameSession(record.id, title.trim()));
        await refresh();
      });
  };
  const indicator =
    record.status === "error"
      ? "error"
      : record.unreadAt !== undefined
        ? "unread"
        : record.running
          ? "running"
          : "none";
  const row = (
    // biome-ignore lint/a11y/noStaticElementInteractions: The overlay is inert; the interactive row has role=button.
    <div
      ref={(element) => {
        draggable.setNodeRef(element);
        droppable.setNodeRef(element);
      }}
      {...(!overlay ? draggable.attributes : {})}
      {...(!overlay ? draggable.listeners : {})}
      role={overlay ? undefined : "button"}
      tabIndex={overlay ? undefined : 0}
      className={`grouped-task-row${selected === record.id ? " active" : ""}${overlay ? " task-group-drag-overlay" : ""}`}
      data-session-id={record.id}
      data-testid={overlay ? undefined : "session-row"}
      data-task-item-key={record.id}
      data-status={record.status ?? "idle"}
      data-indicator={indicator}
      data-dragging={dragging}
      onClick={() => {
        if (!renaming && !overlay) run(() => selectSession(record.id));
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          run(() => selectSession(record.id));
        } else draggable.listeners?.onKeyDown?.(event);
      }}
    >
      {renaming ? (
        <input
          ref={input}
          aria-label="重命名任务"
          className="task-group-name-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commitRename}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              setRenaming(false);
            } else if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              !composing.current &&
              event.keyCode !== 229
            )
              event.currentTarget.blur();
          }}
        />
      ) : (
        <TaskTitleOverflowText as="span">{record.draft ? "新任务" : record.title}</TaskTitleOverflowText>
      )}
      <span className="grouped-task-metadata">
        {record.pendingQuestion ? (
          <QuestionBadge record={record} />
        ) : (
          <>
            <span className="grouped-task-time">
              {indicator === "running" ? (
                <LoaderIcon size={14} className="task-running-icon" />
              ) : indicator !== "none" ? (
                <span className={`task-${indicator}-dot`} />
              ) : null}
              <span>{formatTaskRelativeTime(record.updatedAt)}</span>
            </span>
            {!overlay && (
              <span className="grouped-task-actions">
                <ActionHint
                  label="移动到顶部"
                  appearance="control"
                  open={tooltipsDisabled ? false : undefined}
                >
                  <button
                    aria-label={`移动到顶部 ${record.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      moveTop();
                    }}
                  >
                    <ArrowUpToLine size={14} />
                  </button>
                </ActionHint>
                <ActionHint
                  label={record.running ? "请先停止运行" : "关闭"}
                  appearance="control"
                  open={tooltipsDisabled ? false : undefined}
                >
                  <button
                    aria-label={`关闭任务 ${record.title}`}
                    disabled={record.running || Boolean(record.diagnostic)}
                    onClick={(event) => {
                      event.stopPropagation();
                      close();
                    }}
                  >
                    <X size={14} />
                  </button>
                </ActionHint>
              </span>
            )}
          </>
        )}
      </span>
    </div>
  );
  if (overlay) return row;
  if (record.draft)
    return (
      <div className="grouped-task-wrapper">
        {/* biome-ignore lint/a11y/useSemanticElements: Draft row contains its separate close button. */}
        <div
          className={`grouped-task-row grouped-draft-row${selected === record.id ? " active" : ""}`}
          role="button"
          tabIndex={0}
          data-session-id={record.id}
          data-testid="grouped-draft-row"
          onClick={() => run(() => selectSession(record.id))}
          onKeyDown={(event) => {
            if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              run(() => selectSession(record.id));
            }
          }}
        >
          <span className="grouped-draft-title">新任务</span>
          <span className="grouped-draft-workspace">
            {record.cwd?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "ZPI"}
          </span>
          <span className="grouped-draft-close">
            <span className="grouped-draft-dot" />
            <button
              aria-label="关闭新任务"
              onClick={(event) => {
                event.stopPropagation();
                run(async () => {
                  await prepareDiscardDraft(record.id);
                  await deleteSessionWithPanes(record.id);
                  forgetDiscardedDraft(record.id);
                  await refresh();
                });
              }}
            >
              <X size={14} />
            </button>
          </span>
        </div>
      </div>
    );
  return (
    <Context.Root open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip.Provider delayDuration={0}>
        <Tooltip.Root
          open={tooltipsDisabled || menuOpen ? false : undefined}
          onOpenChange={(open) => {
            if (open) loadChanges();
          }}
        >
          <Tooltip.Trigger asChild>
            <Context.Trigger asChild>
              <div className="grouped-task-wrapper">{row}</div>
            </Context.Trigger>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="message-action-tooltip control-hint-tooltip grouped-task-tooltip"
              side="right"
              align="center"
              sideOffset={6}
            >
              <Folder size={14} />
              <span>{workspaceLabel}</span>
              {changes && (changes.added > 0 || changes.removed > 0) && (
                <>
                  <span>·</span>
                  {changes.added > 0 && <span className="grouped-task-added">+{changes.added}</span>}
                  {changes.removed > 0 && <span className="grouped-task-removed">-{changes.removed}</span>}
                </>
              )}
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
      {menuOpen && (
        <Context.Portal>
          <Context.Content
            className="parity-menu grouped-task-context-menu"
            onCloseAutoFocus={(event) => {
              if (pendingRename.current) {
                event.preventDefault();
                pendingRename.current = false;
                setTitle(record.title);
                setRenaming(true);
              }
            }}
          >
            <Context.Sub>
              <Context.SubTrigger className="menu-item">
                移动到分组
                <ChevronRight size={14} className="menu-sub-arrow" />
              </Context.SubTrigger>
              <Context.Portal>
                <Context.SubContent className="parity-menu task-group-move-menu">
                  <Context.Item
                    className="menu-item"
                    disabled={!groupId}
                    onSelect={() =>
                      run(() => changeTaskGroups({ type: "moveTask", id: record.id, groupId: null }))
                    }
                  >
                    移出分组
                  </Context.Item>
                  <Context.Separator className="menu-separator" />
                  {orderedTaskGroups(state).map((group) => (
                    <Context.Item
                      key={group.id}
                      className="menu-item"
                      disabled={group.id === groupId}
                      onSelect={() =>
                        run(() => changeTaskGroups({ type: "moveTask", id: record.id, groupId: group.id }))
                      }
                    >
                      <TaskGroupColorMark color={group.color} dot />
                      <span className="task-group-move-title">{group.title}</span>
                    </Context.Item>
                  ))}
                </Context.SubContent>
              </Context.Portal>
            </Context.Sub>
            <Context.Item className="menu-item" onSelect={moveTop}>
              移动到顶部
            </Context.Item>
            <Context.Separator className="menu-separator" />
            <Context.Item
              className="menu-item"
              disabled={Boolean(record.diagnostic)}
              onSelect={() => {
                pendingRename.current = true;
              }}
            >
              重命名
            </Context.Item>
            <Context.Item
              className="menu-item"
              disabled={record.running || Boolean(record.diagnostic)}
              onSelect={close}
            >
              归档任务
            </Context.Item>
            <Context.Item
              className="menu-item"
              onSelect={() =>
                run(async () => {
                  unwrap(await window.zpi.setSessionUnread(record.id));
                  await refresh();
                })
              }
            >
              标记未读
            </Context.Item>
            <Context.Separator className="menu-separator" />
            <Context.Item
              className="menu-item"
              onSelect={() =>
                run(async () => {
                  const info = unwrap(await window.zpi.getWorkspaceInfo(record.id));
                  unwrap(await window.zpi.openDirectory(info.cwd));
                })
              }
            >
              <Folder size={14} />
              {window.zpi.platform === "darwin" ? "在 Finder 中显示" : "在文件管理器中显示"}
            </Context.Item>
            <Context.Item
              className="menu-item"
              onSelect={() =>
                run(async () => {
                  const info = unwrap(await window.zpi.getWorkspaceInfo(record.id));
                  unwrap(await window.zpi.copyText(info.cwd));
                })
              }
            >
              复制路径
            </Context.Item>
            <Context.Item
              className="menu-item"
              onSelect={() =>
                run(async () => {
                  unwrap(await window.zpi.copySessionPath(record.id));
                })
              }
            >
              复制会话路径
            </Context.Item>
            <Context.Item
              className="menu-item"
              onSelect={() =>
                run(async () => {
                  unwrap(await window.zpi.copyText(record.id));
                })
              }
            >
              复制会话 ID
            </Context.Item>
          </Context.Content>
        </Context.Portal>
      )}
    </Context.Root>
  );
}
