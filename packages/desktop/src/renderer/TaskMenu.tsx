import * as Menu from "@radix-ui/react-dropdown-menu";
import { Archive, MoreHorizontal, Pencil, Pin, PinOff } from "lucide-react";
import type { SessionRecord } from "../shared/bridge.ts";
import { taskPinLimit } from "../shared/config.ts";
import { DirectoryMenuItems } from "./DirectoryMenuItems.tsx";
import { archiveSession, refresh, report, unwrap, useStore } from "./store.ts";

export function TaskMenu({ record, onRename }: { record: SessionRecord; onRename: () => void }) {
  const pins = useStore((s) => [...s.sessions.values()].filter((r) => r.pinnedAt != null).length);
  const pinned = record.pinnedAt != null;
  const running = record.status === "running";
  const task = (work: () => Promise<unknown>) => void work().catch(report);
  return (
    <Menu.Root>
      <Menu.Trigger className="task-more" aria-label="任务菜单">
        <MoreHorizontal size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="selection-menu task-menu" align="start" sideOffset={6}>
          <Menu.Item
            className="menu-item"
            disabled={!pinned && pins >= taskPinLimit}
            onSelect={() =>
              task(async () => {
                unwrap(await window.ZPI.setSessionPinned(record.id, !pinned));
                await refresh();
              })
            }
          >
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {pinned ? "取消置顶" : "置顶"}
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={onRename}>
            <Pencil size={14} />
            重命名任务
          </Menu.Item>
          <Menu.Item
            className="menu-item"
            disabled={running}
            title={running ? "请先停止运行" : undefined}
            onSelect={() => task(() => archiveSession(record.id))}
          >
            <Archive size={14} />
            归档任务
            {running && <small>请先停止运行</small>}
          </Menu.Item>
          <Menu.Separator className="menu-separator" />
          <DirectoryMenuItems
            getPath={async () => unwrap(await window.ZPI.getWorkspaceInfo(record.id)).cwd}
          />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
