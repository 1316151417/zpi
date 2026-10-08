import { ActionHint, TaskTitleOverflowText } from "ZPI-ui";
import { Archive, LoaderIcon, Pin } from "lucide-react";
import { useState } from "react";
import type { SessionRecord } from "../shared/bridge.ts";
import { formatTaskRelativeTime } from "./sidebar-task-model.ts";

export function SidebarTaskRow({
  record: r,
  active,
  workspace,
  variant = "default",
  pinLimitReached,
  onSelect,
  onPin,
  onArchive,
}: {
  record: SessionRecord;
  active: boolean;
  workspace: string;
  variant?: "default" | "timeline";
  pinLimitReached: boolean;
  onSelect(): void;
  onPin(): void;
  onArchive(): void;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [touch] = useState(() => matchMedia("(hover: none)").matches);
  const interacting = hover || focus;
  const indicator =
    r.status === "error" ? "error" : r.unreadAt !== undefined ? "unread" : r.running ? "running" : "none";
  const showPin = interacting || (r.pinnedAt != null && indicator === "none");
  const actions =
    interacting || touch ? (
      <ActionHint label={r.running ? "请先停止运行" : "归档任务"} appearance="control">
        <span className="task-row-actions">
          <button
            className="row-action task-archive"
            aria-label={`归档任务 ${r.title}`}
            disabled={r.running || Boolean(r.diagnostic)}
            onClick={(event) => {
              event.stopPropagation();
              onArchive();
            }}
          >
            <Archive size={14} />
          </button>
        </span>
      </ActionHint>
    ) : null;
  const time = !interacting ? (
    <span className="task-row-time" data-task-row-metadata="true">
      {formatTaskRelativeTime(r.updatedAt)}
    </span>
  ) : null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: Composite task row contains independent pin and archive buttons.
    <div
      className={`session-row ${active ? "active" : ""} ${variant === "timeline" ? "timeline-row" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect();
        }
      }}
      data-testid="session-row"
      data-session-id={r.id}
      data-task-item-key={r.id}
      data-status={r.status ?? "idle"}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocusCapture={() => setFocus(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocus(false);
      }}
    >
      <span className="task-leading-slot">
        <span className="task-indicator" aria-hidden="true" style={{ opacity: showPin ? 0 : 1 }}>
          {indicator === "error" ? (
            <span data-error-indicator="true" className="task-error-dot" />
          ) : indicator === "unread" ? (
            <span data-unread-indicator="true" className="task-unread-dot" />
          ) : indicator === "running" ? (
            <LoaderIcon className="task-running-icon" size={16} data-loading-indicator="true" />
          ) : variant === "timeline" ? (
            <span className="task-idle-dot" />
          ) : null}
        </span>
        <ActionHint
          appearance="control"
          label={
            r.pinnedAt != null
              ? "取消置顶任务"
              : pinLimitReached
                ? "最多置顶 5 个任务，请先取消其他任务的置顶"
                : "置顶任务"
          }
        >
          <button
            style={{ opacity: showPin ? 1 : 0, pointerEvents: showPin ? "auto" : "none" }}
            tabIndex={showPin ? 0 : -1}
            className={`row-action task-pin ${r.pinnedAt != null ? "pinned" : ""}`}
            aria-label={`${r.pinnedAt != null ? "取消置顶" : "置顶"}任务 ${r.title}`}
            disabled={r.pinnedAt == null && pinLimitReached}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onPin();
            }}
          >
            <Pin size={16} />
          </button>
        </ActionHint>
      </span>
      {variant === "timeline" ? (
        <div className="timeline-row-body">
          <button
            className="session-name"
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
          >
            <TaskTitleOverflowText as="span">{r.title}</TaskTitleOverflowText>
          </button>
          <div className="timeline-row-metadata">
            <span className="task-workspace-label">{workspace}</span>
            <div>
              {time}
              {actions}
            </div>
          </div>
        </div>
      ) : (
        <>
          <button
            className="session-name"
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
          >
            <TaskTitleOverflowText as="span">{r.title}</TaskTitleOverflowText>
          </button>
          {time}
          {actions}
        </>
      )}
    </div>
  );
}
