// Adapted from ZCode ProjectSidebarListHeader (Apache-2.0), 3c5b2276.
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, Clock, Folder, Hash, ListFilter } from "lucide-react";
import { ActionHint } from "zpi-ui";
import type { TaskPreferences } from "./sidebar-task-model.ts";

export function TaskViewMenu({
  value,
  onChange,
}: {
  value: TaskPreferences;
  onChange(value: TaskPreferences): void;
}) {
  return (
    <Menu.Root>
      <ActionHint label="筛选视图" appearance="control">
        <Menu.Trigger className="task-view-trigger" aria-label="筛选视图" data-testid="sidebar-view-menu">
          <ListFilter className="task-list-header-icon" />
        </Menu.Trigger>
      </ActionHint>
      <Menu.Portal>
        <Menu.Content className="parity-menu task-view-menu" align="end" sideOffset={2} aria-label="筛选视图">
          <Menu.RadioGroup
            className="parity-menu-group"
            value={value.organizeBy}
            onValueChange={(organizeBy) => {
              if (organizeBy === "project" || organizeBy === "grouped" || organizeBy === "chronological")
                onChange({ organizeBy });
            }}
          >
            {(
              [
                ["project", "按项目", Folder],
                ["grouped", "按分组", Hash],
                ["chronological", "最近更新", Clock],
              ] as const
            ).map(([id, label, Icon]) => (
              <Menu.RadioItem key={id} className="parity-menu-radio" value={id}>
                <span className="parity-menu-indicator">
                  <Menu.ItemIndicator>
                    <Check className="task-view-check-icon" />
                  </Menu.ItemIndicator>
                </span>
                <Icon className="task-view-option-icon" />
                {label}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
