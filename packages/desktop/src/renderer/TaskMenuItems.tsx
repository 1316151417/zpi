import * as Menu from "@radix-ui/react-dropdown-menu";
import { Archive, Copy, Pencil, Pin, PinOff } from "lucide-react";
import type { SessionRecord } from "../shared/bridge.ts";
import { taskPinLimit } from "../shared/config.ts";
import { DirectoryMenuItems } from "./DirectoryMenuItems.tsx";
import { archiveSession, refresh, report, unwrap, useStore } from "./store.ts";

/** Shared actions and ordering for the header dropdown and grouped-task context menu. */
export function TaskMenuItems({
  record,
  onRename,
  Item = Menu.Item,
  Separator = Menu.Separator,
}: {
  record: SessionRecord;
  onRename: () => void;
  Item?: typeof Menu.Item;
  Separator?: typeof Menu.Separator;
}) {
  const pins = useStore((s) => [...s.sessions.values()].filter((r) => r.pinnedAt != null).length);
  const pinned = record.pinnedAt != null;
  const running = record.running || record.status === "running";
  const task = (work: () => Promise<unknown>) => void work().catch(report);
  return (
    <>
      <Item
        className="menu-item"
        disabled={!pinned && pins >= taskPinLimit}
        onSelect={() =>
          task(async () => {
            unwrap(await window.zpi.setSessionPinned(record.id, !pinned));
            await refresh();
          })
        }
      >
        {pinned ? <PinOff size={16} /> : <Pin size={16} />}
        {pinned ? "取消置顶" : "置顶"}
      </Item>
      <Item className="menu-item" disabled={Boolean(record.diagnostic)} onSelect={onRename}>
        <Pencil size={16} />
        重命名任务
      </Item>
      <Item
        className="menu-item"
        disabled={running || Boolean(record.diagnostic)}
        title={running ? "请先停止运行" : undefined}
        onSelect={() => task(() => archiveSession(record.id))}
      >
        <Archive size={16} />
        归档任务
        {running && <small>请先停止运行</small>}
      </Item>
      <Separator className="menu-separator" />
      <DirectoryMenuItems
        Item={Item}
        getPath={async () => unwrap(await window.zpi.getWorkspaceInfo(record.id)).cwd}
      />
      <Item
        className="menu-item"
        onSelect={() =>
          task(async () => {
            unwrap(await window.zpi.copySessionPath(record.id));
          })
        }
      >
        <Copy size={14} />
        复制会话路径
      </Item>
    </>
  );
}
