// Adapted from ZCode SidePaneTabOverview and sidePaneTabSearch (Apache-2.0).
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { ChevronsDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ActionHint } from "zpi-ui";
import { PaneTabIcon } from "./PaneTabIcon.tsx";
import {
  activatePaneTab,
  closeTab,
  type PaneTab,
  paneTask,
  reopenPaneTab,
  usePane,
  visiblePaneTabs,
} from "./pane-store.ts";

function formatTaskRelativeTime(timestamp: number, now: number) {
  const minutes = Math.floor((now - timestamp) / 60000);
  return minutes < 1
    ? "刚刚"
    : minutes < 60
      ? `${minutes} 分钟前`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} 小时前`
        : `${Math.floor(minutes / 1440)} 天前`;
}

function rank(tabs: PaneTab[], query: string) {
  const parts = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return tabs;
  return tabs
    .map((tab, index) => {
      const title = tab.title.toLocaleLowerCase();
      const hint = (
        tab.type === "changes"
          ? (tab.path ?? "")
          : tab.type === "browser"
            ? tab.state.url
            : "cwd" in tab
              ? (tab.cwd ?? "")
              : ""
      ).toLocaleLowerCase();
      const typeLabel =
        tab.type === "changes" && tab.reviewSource
          ? "审查"
          : tab.type === "browser"
            ? "浏览器"
            : tab.type === "terminal" || tab.type === "background-task"
              ? "终端"
              : ["file-manager", "file", "changes"].includes(tab.type)
                ? "文件"
                : tab.type === "new-tab"
                  ? "新标签页"
                  : tab.type.startsWith("side-chat")
                    ? "辅助对话"
                    : "任务";
      const all = `${title} ${hint} ${typeLabel}`;
      const score = parts.every((part) => all.includes(part))
        ? parts.reduce(
            (score, part) =>
              score +
              (title.startsWith(part)
                ? 120
                : title.split(/[\s/_.:-]+/).some((word) => word.startsWith(part))
                  ? 90
                  : title.includes(part)
                    ? 70
                    : hint.includes(part)
                      ? 40
                      : 20),
            0,
          )
        : -1;
      return { tab, index, score };
    })
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ tab }) => tab);
}
export function PaneTabOverview({ sessionId }: { sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now);
  const state = usePane();
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [open]);
  const tabs = useMemo(
    () => rank(visiblePaneTabs(sessionId, state.tabs), query),
    [sessionId, state.tabs, query],
  );
  const closed = useMemo(
    () =>
      rank(
        visiblePaneTabs(
          sessionId,
          state.recentClosed.map(({ tab }) => tab),
        ),
        query,
      ),
    [sessionId, state.recentClosed, query],
  );
  const choose = (id: string, closed: boolean) => {
    if (closed) paneTask(reopenPaneTab(id));
    else activatePaneTab(id);
    setOpen(false);
    setQuery("");
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setQuery("");
      }}
    >
      <ActionHint label="搜索标签页" appearance="control" side="bottom">
        <Popover.Trigger className="pane-header-action" aria-label="搜索标签页">
          <ChevronsDown size={16} />
        </Popover.Trigger>
      </ActionHint>
      <Popover.Portal>
        <Popover.Content
          className="pane-tab-overview"
          align="start"
          sideOffset={4}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <Command shouldFilter={false} label="搜索标签页">
            <div className="pane-overview-search">
              <Search size={16} />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="搜索标签页..."
                aria-label="搜索标签页..."
              />
            </div>
            <Command.List>
              {(
                [
                  [false, tabs, "打开的标签页"],
                  [true, closed, "最近关闭的标签页"],
                ] as const
              ).map(([isClosed, tabs, title]) =>
                tabs.length || (!isClosed && !closed.length) ? (
                  <Command.Group key={title} heading={title}>
                    {!tabs.length && <Command.Empty>没有找到标签页。</Command.Empty>}
                    {tabs.map((tab) => (
                      <Command.Item
                        key={tab.id}
                        value={`${isClosed}:${tab.id}`}
                        onSelect={() => choose(tab.id, isClosed)}
                        data-active={(!isClosed && state.active === tab.id) || undefined}
                      >
                        <span className="pane-overview-icon">
                          <PaneTabIcon tab={tab} />
                        </span>
                        <span className="pane-overview-title">{tab.title}</span>
                        <span className="pane-overview-time">
                          {formatTaskRelativeTime(
                            isClosed
                              ? (state.recentClosed.find(({ tab: closed }) => closed.id === tab.id)
                                  ?.closedAt ?? now)
                              : (tab.openedAt ?? now),
                            now,
                          )}
                          {isClosed ? "关闭" : "打开"}
                        </span>
                        {!isClosed && (
                          <button
                            aria-label={`关闭标签 ${tab.title}`}
                            onPointerDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              paneTask(closeTab(tab.id));
                            }}
                          >
                            <X size={12} />
                          </button>
                        )}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ) : null,
              )}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
