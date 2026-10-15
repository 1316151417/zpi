import * as Menu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { ActionHint } from "zpi-ui";
import type { SessionRecord } from "../shared/bridge.ts";
import { formatShortcut } from "../shared/shortcuts.ts";
import { useStore } from "./store.ts";
import { TaskMenuItems } from "./TaskMenuItems.tsx";
import { useOverlayShortcut } from "./use-overlay-shortcut.ts";

export function TaskMenu({
  record,
  open,
  onOpenChange,
  onRename,
}: {
  record: SessionRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: () => void;
}) {
  const shortcuts = useStore((state) => state.settings?.shortcuts);
  const opener = useRef<Element | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const attachMenu = useCallback((element: HTMLDivElement | null) => {
    if (element && menu.current !== element) opener.current = document.activeElement;
    menu.current = element;
  }, []);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useOverlayShortcut("task-menu", open, () => onOpenChange(false));
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <ActionHint
        label="任务菜单"
        appearance="control"
        open={open ? false : undefined}
        shortcut={
          shortcuts?.enabled && shortcuts.bindings["task-menu"]
            ? formatShortcut(shortcuts.bindings["task-menu"], window.zpi.platform)
            : undefined
        }
      >
        <Menu.Trigger className="task-more" aria-label="任务菜单">
          <MoreHorizontal size={16} />
        </Menu.Trigger>
      </ActionHint>
      <Menu.Portal>
        <Menu.Content
          ref={attachMenu}
          className="selection-menu task-menu"
          align="start"
          sideOffset={2}
          data-shortcut-owner="task-menu"
          loop
          onCloseAutoFocus={(event) => {
            if (opener.current instanceof HTMLElement && opener.current.isConnected) {
              event.preventDefault();
              opener.current.focus();
            }
          }}
        >
          <TaskMenuItems record={record} onRename={onRename} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
