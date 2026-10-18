import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, Clock3, Folder, GripVertical, Hash, ListFilter, MessageCirclePlus } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { ActionHint } from "zpi-ui";
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
  const workspaceView = useRef<"project" | "chronological">(
    value.organizeBy === "chronological" ? "chronological" : "project",
  );
  if (value.organizeBy !== "grouped") workspaceView.current = value.organizeBy;
  if (viewOnly)
    return (
      <fieldset className="task-primary-tabs" aria-label="组织任务">
        <button
          aria-pressed={value.organizeBy === "grouped"}
          onClick={() => onChange({ ...value, organizeBy: "grouped" })}
        >
          <Hash size={12} />
          分组
        </button>
        <button
          aria-pressed={value.organizeBy !== "grouped"}
          onClick={() =>
            onChange({
              ...value,
              organizeBy: workspaceView.current,
            })
          }
        >
          <Folder size={12} />
          项目
        </button>
      </fieldset>
    );
  const grouped = value.organizeBy === "grouped";
  const sortBy = grouped ? (value.groupSortBy ?? "updated") : value.sortBy;
  const sortLabels = { updated: "更新时间", created: "创建时间", manual: "手动排序" };
  const label = grouped ? `任务排序：${sortLabels[sortBy]}` : "筛选和排序";
  const option = (id: string, label: string, icon: ReactNode) => (
    <Menu.RadioItem className="parity-menu-radio" value={id}>
      {icon}
      {label}
      <Menu.ItemIndicator className="parity-menu-indicator">
        <Check size={16} />
      </Menu.ItemIndicator>
    </Menu.RadioItem>
  );
  return (
    <Menu.Root>
      <ActionHint label={label} appearance="control">
        <Menu.Trigger className="task-view-trigger" aria-label={label}>
          {grouped && sortBy === "manual" ? <GripVertical size={14} /> : <ListFilter size={14} />}
        </Menu.Trigger>
      </ActionHint>
      <Menu.Portal>
        <Menu.Content className="parity-menu task-view-menu" align="end" sideOffset={2} aria-label={label}>
          {!grouped && (
            <>
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
              <Menu.Separator className="parity-menu-separator" />
            </>
          )}
          <Menu.Label className="parity-menu-label">{grouped ? "任务排序" : "排序方式"}</Menu.Label>
          <Menu.RadioGroup
            className="parity-menu-group"
            value={sortBy}
            onValueChange={(sortBy) => {
              if (grouped && (sortBy === "manual" || sortBy === "created" || sortBy === "updated"))
                onChange({ ...value, groupSortBy: sortBy });
              else if (sortBy === "created" || sortBy === "updated") onChange({ ...value, sortBy });
            }}
          >
            {option("updated", "更新时间", <TaskUpdatedIcon size={16} />)}
            {option("created", "创建时间", <MessageCirclePlus size={16} />)}
            {grouped && option("manual", "手动排序", <GripVertical size={16} />)}
          </Menu.RadioGroup>
          {grouped && <Menu.Label className="parity-menu-label">拖拽请选手动排序</Menu.Label>}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
