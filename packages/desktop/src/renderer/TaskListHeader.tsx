// Adapted from ZCode ProjectSidebarListHeader (Apache-2.0), 3c5b2276.
import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { ActionHint } from "zpi-ui";
import type { TaskPreferences } from "./sidebar-task-model.ts";
import { TaskViewMenu } from "./TaskViewMenu.tsx";

export function TaskListHeader({
  value,
  onChange,
  onSearch,
  searchShortcut,
  children,
}: {
  value: TaskPreferences;
  onChange(value: TaskPreferences): void;
  onSearch(): void;
  searchShortcut?: string;
  children?: ReactNode;
}) {
  return (
    <div className="sidebar-task-toolbar" data-testid="sidebar-search-toolbar">
      <span className="sidebar-list-title" data-testid="sidebar-list-title">
        任务列表
      </span>
      <div className="sidebar-task-toolbar-actions">
        {children}
        <ActionHint label="搜索" shortcut={searchShortcut} appearance="control">
          <button
            className="task-view-trigger"
            aria-label="搜索"
            data-testid="sidebar-search-open"
            onClick={onSearch}
          >
            <Search className="task-list-header-icon" />
          </button>
        </ActionHint>
        <TaskViewMenu value={value} onChange={onChange} />
      </div>
    </div>
  );
}
