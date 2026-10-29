import {
  MessageCirclePlus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { ActionHint } from "zpi-ui";
import type { ShortcutCommand } from "../shared/shortcuts.ts";

// Adapted from ZCode DesktopTopOverlay and WorkspaceSidePaneToggleButton.
// See licenses/third-party-notices.txt for provenance.
export function WindowChrome({
  leftCollapsed,
  rightOpen,
  hidden,
  onNewTask,
  onToggleLeft,
  onToggleRight,
  shortcutHint,
}: {
  leftCollapsed: boolean;
  rightOpen: boolean;
  hidden: boolean;
  onNewTask: () => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  shortcutHint: (command: ShortcutCommand) => string;
}) {
  const LeftIcon = leftCollapsed ? PanelLeftOpen : PanelLeftClose;
  const RightIcon = rightOpen ? PanelRightClose : PanelRightOpen;
  return (
    <>
      <div className="sidebar-drag-space" aria-hidden="true" hidden={hidden || leftCollapsed} />
      <div className="desktop-top-controls" hidden={hidden}>
        <div className="desktop-top-actions">
          <ActionHint
            shortcut={shortcutHint("toggle-sidebar")}
            label="切换侧边栏"
            appearance="control"
            side="bottom"
          >
            <button
              className="window-chrome-button"
              data-testid="left-sidebar-toggle"
              aria-label={leftCollapsed ? "展开侧边栏" : "收起侧边栏"}
              aria-expanded={!leftCollapsed}
              onClick={onToggleLeft}
            >
              <LeftIcon size={16} aria-hidden="true" />
            </button>
          </ActionHint>
          {leftCollapsed && (
            <ActionHint
              label="新建任务"
              shortcut={shortcutHint("new-task")}
              appearance="control"
              side="bottom"
            >
              <button className="window-chrome-button" aria-label="新建任务" onClick={onNewTask}>
                <MessageCirclePlus size={16} />
              </button>
            </ActionHint>
          )}
        </div>
      </div>
      <ActionHint shortcut={shortcutHint("toggle-pane")} label="切换面板" appearance="control" side="bottom">
        <button
          className="window-chrome-button right-sidebar-toggle"
          data-testid="right-sidebar-toggle"
          hidden={hidden}
          aria-label={rightOpen ? "收起右侧栏" : "展开右侧栏"}
          aria-expanded={rightOpen}
          onClick={onToggleRight}
        >
          <RightIcon size={16} aria-hidden="true" />
        </button>
      </ActionHint>
    </>
  );
}
