import { ActionHint } from "ZPI-ui";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, Clock3, Folder, ListFilter, MessageCirclePlus } from "lucide-react";
import type { ReactNode } from "react";
import type { TaskPreferences } from "./sidebar-task-model.ts";
import { TaskUpdatedIcon } from "./task-view-icons.ts";
export function TaskViewMenu({
  value,
  onChange,
  viewOnly = false,
}: {
  value: TaskPreferences;
  onChange(value: TaskPreferences): void;
  viewOnly?: boolean;
}) {
  const label = viewOnly ? "切换视图" : "筛选和排序";
  const projectView = value.organizeBy === "project";
  const viewLabel = projectView ? "项目" : "时间线";
  const option = (id: string, label: string, icon: ReactNode) => (
    <Menu.RadioItem className="parity-menu-radio" value={id}>
      {icon}
      {label}
      <Menu.ItemIndicator className="parity-menu-indicator">
        <Check size={16} />
      </Menu.ItemIndicator>
    </Menu.RadioItem>
  );
  const trigger = (
    <Menu.Trigger
      className={viewOnly ? "task-view-selector" : "task-view-trigger"}
      aria-label={viewOnly ? `${label}，当前为${viewLabel}` : label}
    >
      {viewOnly ? (
        <>
          {projectView ? <Folder size={12} /> : <Clock3 size={12} />}
          <span>{viewLabel}</span>
        </>
      ) : (
        <ListFilter size={14} />
      )}
    </Menu.Trigger>
  );
  return (
    <Menu.Root>
      {viewOnly ? (
        trigger
      ) : (
        <ActionHint label={label} appearance="control">
          {trigger}
        </ActionHint>
      )}
      <Menu.Portal>
        <Menu.Content
          className="parity-menu task-view-menu"
          align={viewOnly ? "start" : "end"}
          sideOffset={2}
          aria-label={label}
        >
          <Menu.Label className="parity-menu-label">视图</Menu.Label>
          <Menu.RadioGroup
            className="parity-menu-group"
            value={value.organizeBy}
            onValueChange={(organizeBy) => {
              if (organizeBy === "project" || organizeBy === "chronological")
                onChange({ ...value, organizeBy });
            }}
          >
            {option("project", "按项目", <Folder size={16} />)}
            {option("chronological", "时间线", <Clock3 size={16} />)}
          </Menu.RadioGroup>
          {!viewOnly && (
            <>
              <Menu.Separator className="parity-menu-separator" />
              <Menu.Label className="parity-menu-label">排序方式</Menu.Label>
              <Menu.RadioGroup
                className="parity-menu-group"
                value={value.sortBy}
                onValueChange={(sortBy) => {
                  if (sortBy === "created" || sortBy === "updated") onChange({ ...value, sortBy });
                }}
              >
                {option("updated", "更新时间", <TaskUpdatedIcon size={16} />)}
                {option("created", "创建时间", <MessageCirclePlus size={16} />)}
              </Menu.RadioGroup>
            </>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
