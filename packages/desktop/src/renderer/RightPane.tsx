import * as Context from "@radix-ui/react-context-menu";
import { Maximize2, MessageCircle, Minimize2, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { ActionHint, type FindRequest, type FindState } from "zpi-ui";
import { formatShortcut } from "../shared/shortcuts.ts";
import { BackgroundTaskPane } from "./BackgroundTaskPane.tsx";
import { BrowserPane } from "./BrowserPane.tsx";
import { ChangesPane } from "./ChangesPane.tsx";
import { FileManagerPane } from "./FileManagerPane.tsx";
import { PaneLauncher } from "./PaneLauncher.tsx";
import { PaneTabIcon } from "./PaneTabIcon.tsx";
import { PaneTabOverview } from "./PaneTabOverview.tsx";
import {
  activatePaneTab,
  canOpenSideChat,
  closePaneTabs,
  closeTab,
  openNewPaneTab,
  paneTask,
  reorderPaneTab,
  selectReviewSource,
  togglePaneFullView,
  updatePaneFullView,
  usePane,
  visiblePaneTabs,
} from "./pane-store.ts";
import "./pane-tabs.css";
import { ReviewPane } from "./ReviewPane.tsx";
import { SideChatPane } from "./SideChatPane.tsx";
import { SubagentPane } from "./SubagentPane.tsx";
import { useStore } from "./store.ts";
import { TaskDirectory } from "./TaskActivity.tsx";
import { TerminalPane } from "./TerminalPane.tsx";
export function RightPane({
  available,
  sessionId,
  findRequest,
  onFindStateChange,
  onSettings,
}: {
  findRequest?: FindRequest;
  onFindStateChange?: (state: FindState) => void;
  available: number;
  sessionId?: string;
  onSettings: () => void;
}) {
  const sideChatAvailable = useStore((state) => {
    const record = state.sessions.get(sessionId ?? "");
    return canOpenSideChat(record);
  });
  const state = usePane();
  const conversationTitle = useStore((state) => state.sessions.get(sessionId ?? "")?.title ?? "对话");
  const fullViewShortcut = useStore((state) =>
    state.settings?.shortcuts.enabled ? state.settings.shortcuts.bindings["pane-full-view"] : null,
  );
  const panel = useRef<HTMLElement>(null);
  const previousOpen = useRef(state.open);
  useLayoutEffect(() => {
    if (previousOpen.current === state.open) return;
    previousOpen.current = state.open;
    const element = panel.current;
    if (!element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // 仅显式开合沿用 ZCode 的 200ms ease-out；锁住内容宽度，避免逐帧重排。
    element.dataset.animating = "true";
    const finish = () => element.removeAttribute("data-animating");
    const timer = setTimeout(finish, 240);
    // 原生窗口 resize 即刻打断开合过渡，不让宽度追着窗口变化。
    window.addEventListener("resize", finish);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", finish);
      finish();
    };
  }, [state.open]);
  const tabs = visiblePaneTabs(sessionId, state.tabs);
  const active =
    state.fullView?.surface === "conversation" ? undefined : tabs.find((tab) => tab.id === state.active)?.id;
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = tabsRef.current?.querySelector<HTMLElement>(".pane-tab.selected");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.active]);
  return (
    <aside ref={panel} className="right-pane" hidden={!state.open} inert={!state.open} aria-label="右侧栏">
      <hr
        className="right-resizer"
        aria-label="右侧栏宽度"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={(event) => {
          panel.current?.removeAttribute("data-animating");
          panel.current?.setAttribute("data-resizing", "true");
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            usePane.setState({
              ratio: Math.max(0.2, Math.min(0.7, (window.innerWidth - event.clientX) / available)),
            });
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          localStorage.setItem("zpi.rightPaneRatio", String(usePane.getState().ratio));
        }}
        onLostPointerCapture={() => panel.current?.removeAttribute("data-resizing")}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            panel.current?.removeAttribute("data-animating");
            const ratio = Math.max(
              0.2,
              Math.min(0.7, state.ratio + (event.key === "ArrowLeft" ? 0.03 : -0.03)),
            );
            usePane.setState({ ratio });
            localStorage.setItem("zpi.rightPaneRatio", String(ratio));
          }
        }}
      />
      <div className="right-pane-frame">
        <div className="right-pane-content">
          <div className="pane-header">
            <PaneTabOverview sessionId={sessionId} />
            <div ref={tabsRef} role="tablist" aria-label="侧栏标签" className="pane-tabs">
              {state.fullView && (
                <div
                  className={`pane-tab pane-conversation-tab ${state.fullView.surface === "conversation" ? "selected" : ""}`}
                  role="tab"
                  aria-selected={state.fullView.surface === "conversation"}
                  aria-label={conversationTitle}
                  tabIndex={0}
                  onClick={() =>
                    updatePaneFullView({
                      surface: "conversation",
                      floating: state.fullView?.floating ?? "collapsed",
                    })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      updatePaneFullView({
                        surface: "conversation",
                        floating: state.fullView?.floating ?? "collapsed",
                      });
                    }
                  }}
                >
                  <MessageCircle size={16} />
                  <span className="pane-conversation-title">{conversationTitle}</span>
                </div>
              )}
              {tabs.map((tab) => (
                <Context.Root key={tab.id}>
                  <Context.Trigger asChild>
                    <div
                      role="tab"
                      aria-label={tab.title}
                      tabIndex={active === tab.id ? 0 : -1}
                      aria-selected={active === tab.id}
                      onKeyDown={(event) => {
                        if (event.key === "Delete") {
                          event.preventDefault();
                          paneTask(closeTab(tab.id));
                        }
                        if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                          event.preventDefault();
                          const index = tabs.findIndex((item) => item.id === tab.id);
                          const next =
                            tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
                          if (next) activatePaneTab(next.id);
                        }
                      }}
                      key={tab.id}
                      className={`pane-tab ${active === tab.id ? "selected" : ""}`}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData("application/x-zpi-pane-tab", tab.id);
                      }}
                      onDragOver={(event) => {
                        if (event.dataTransfer.types.includes("application/x-zpi-pane-tab"))
                          event.preventDefault();
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const id = event.dataTransfer.getData("application/x-zpi-pane-tab");
                        reorderPaneTab(id, tab.id);
                      }}
                      onAuxClick={(event) => {
                        if (event.button === 1) {
                          event.preventDefault();
                          paneTask(closeTab(tab.id));
                        }
                      }}
                    >
                      <button
                        className="pane-tab-trigger"
                        title={tab.title}
                        onClick={(event) => {
                          if (event.button !== 1) activatePaneTab(tab.id);
                        }}
                      >
                        <span className="pane-tab-content">
                          <span className="pane-tab-icon">
                            <PaneTabIcon tab={tab} />
                          </span>
                          <span className="pane-tab-title">{tab.title}</span>
                          {tab.type === "changes" && !tab.reviewSource && (
                            <span className="pane-tab-diff-badge">Diff</span>
                          )}
                        </span>
                      </button>
                      <button
                        className="tab-close"
                        aria-label={`关闭标签 ${tab.title}`}
                        onClick={() => paneTask(closeTab(tab.id))}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </Context.Trigger>
                  <Context.Portal>
                    <Context.Content className="parity-menu pane-tab-menu">
                      <Context.Item className="parity-menu-item" onSelect={() => paneTask(closeTab(tab.id))}>
                        关闭标签
                      </Context.Item>
                      <Context.Item
                        className="parity-menu-item"
                        disabled={tabs.length < 2}
                        onSelect={() => paneTask(closePaneTabs(tab.id))}
                      >
                        关闭其他标签
                      </Context.Item>
                      <Context.Item className="parity-menu-item" onSelect={() => paneTask(closePaneTabs())}>
                        关闭所有标签
                      </Context.Item>
                    </Context.Content>
                  </Context.Portal>
                </Context.Root>
              ))}
            </div>
            <button className="pane-add-tab" aria-label="新增侧栏标签" onClick={openNewPaneTab}>
              <Plus size={16} />
            </button>
            <div className="pane-drag-space" aria-hidden="true" />
            <ActionHint
              label={state.fullView ? "退出完整视图" : "进入完整视图"}
              shortcut={fullViewShortcut ? formatShortcut(fullViewShortcut, window.zpi.platform) : ""}
              appearance="control"
              side="bottom"
            >
              <button
                className="pane-header-action"
                aria-label={state.fullView ? "退出完整视图" : "进入完整视图"}
                aria-pressed={Boolean(state.fullView)}
                onClick={togglePaneFullView}
              >
                {state.fullView ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            </ActionHint>
          </div>
          {tabs.length === 0 && (
            <PaneLauncher sessionId={sessionId} sideChatAvailable={sideChatAvailable} hasReview={false} />
          )}
          {state.tabs.map((tab) => (
            <div
              key={tab.id}
              className="pane-content"
              role="tabpanel"
              aria-label={tab.title}
              hidden={tab.id !== active}
            >
              {tab.type === "new-tab" ? (
                <PaneLauncher
                  sessionId={sessionId}
                  sideChatAvailable={sideChatAvailable}
                  hasReview={tabs.some((tab) => tab.type === "changes" && Boolean(tab.reviewSource))}
                />
              ) : tab.type === "file-manager" ||
                tab.type === "file" ||
                (tab.type === "changes" && tab.path) ? (
                <FileManagerPane
                  tab={tab}
                  visible={state.open && tab.id === active}
                  findRequest={tab.id === active ? findRequest : undefined}
                  onFindStateChange={onFindStateChange}
                />
              ) : tab.type === "background-task" ? (
                <BackgroundTaskPane
                  sessionId={tab.sessionId}
                  taskId={tab.taskId}
                  visible={state.open && tab.id === active}
                />
              ) : tab.type === "task-directory" ? (
                <TaskDirectory sessionId={tab.sessionId} visible={state.open && tab.id === active} />
              ) : tab.type === "subagent" ? (
                <SubagentPane tab={tab} />
              ) : tab.type === "side-chat-loading" ? (
                <div
                  className="side-chat-loading"
                  role="status"
                  aria-busy="true"
                  aria-label="正在创建辅助对话"
                />
              ) : tab.type === "side-chat" ? (
                <SideChatPane
                  sessionId={tab.childSessionId}
                  visible={state.open && tab.id === active}
                  onSettings={onSettings}
                />
              ) : tab.type === "changes" && tab.reviewSource ? (
                <ReviewPane
                  sessionId={tab.sessionId}
                  visible={state.open && tab.id === active}
                  source={tab.reviewSource ?? "unstaged"}
                  onSourceChange={(source) => selectReviewSource(tab.id, source)}
                  findRequest={tab.id === active ? findRequest : undefined}
                  onFindStateChange={onFindStateChange}
                />
              ) : tab.type === "changes" ? (
                <ChangesPane
                  findRequest={tab.id === active ? findRequest : undefined}
                  onFindStateChange={onFindStateChange}
                  sessionId={tab.sessionId}
                  runId={tab.runId}
                  path={tab.path}
                  toolCallId={tab.toolCallId}
                  visible={state.open && tab.id === active}
                />
              ) : tab.type === "terminal" ? (
                <TerminalPane
                  id={tab.id}
                  sessionId={tab.sessionId}
                  cwd={tab.cwd}
                  profile={tab.profile}
                  visible={state.open && tab.id === active}
                />
              ) : (
                <BrowserPane state={tab.state} visible={state.open && tab.id === active} />
              )}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
