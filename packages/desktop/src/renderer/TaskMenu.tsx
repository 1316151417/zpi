import * as Menu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import type { SessionRecord } from "../shared/bridge.ts";
import { TaskMenuItems } from "./TaskMenuItems.tsx";

export function TaskMenu({ record, onRename }: { record: SessionRecord; onRename: () => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger className="task-more" aria-label="任务菜单">
        <MoreHorizontal size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="selection-menu task-menu" align="start" sideOffset={2}>
          <TaskMenuItems record={record} onRename={onRename} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
