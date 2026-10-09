import { FileIcon, type FindRequest, type FindState } from "ZPI-ui";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { FileDiff as Files, Globe, Plus, SquareTerminal as TerminalSquare, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { BrowserPane } from "./BrowserPane.tsx";
import { ChangesPane } from "./ChangesPane.tsx";
import { FilePane } from "./FilePane.tsx";
import {
  activatePaneTab,
  closeTab,
  openBrowser,
  openChanges,
  openTerminal,
  paneTask,
  reorderPaneTab,
  usePane,
  visiblePaneTabs,
} from "./pane-store.ts";
import { TerminalPane } from "./TerminalPane.tsx";
export function RightPane({
  available,
  sessionId,
  findRequest,
  onFindStateChange,
}: {
  findRequest?: FindRequest;
  onFindStateChange?: (state: FindState) => void;
  available: number;
  sessionId?: string;
}) {
  const state = usePane();
  const panel = useRef<HTMLElement>(null);
  const previousOpen = useRef(state.open);
  useLayoutEffect(() => {
    if (previousOpen.current === state.open) return;
    previousOpen.current = state.open;
    const element = panel.current;
    if (!element) return;
    // Like ZCode, animate explicit toggles only; dragging and window resize stay immediate.
    element.dataset.animating = "true";
    const timer = setTimeout(() => element.removeAttribute("data-animating"), 240);
    return () => {
      clearTimeout(timer);
      element.removeAttribute("data-animating");
    };
  }, [state.open]);
  const tabs = visiblePaneTabs(sessionId, state.tabs);
  const active = tabs.find((tab) => tab.id === state.active)?.id;
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
          localStorage.setItem("ZPI.rightPaneRatio", String(usePane.getState().ratio));
        }}
        onLostPointerCapture={() => panel.current?.removeAttribute("data-resizing")}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            const ratio = Math.max(
              0.2,
              Math.min(0.7, state.ratio + (event.key === "ArrowLeft" ? 0.03 : -0.03)),
            );
            usePane.setState({ ratio });
            localStorage.setItem("ZPI.rightPaneRatio", String(ratio));
          }
        }}
      />
      <div className="right-pane-frame">
        <div className="right-pane-content">
          <div className="pane-header">
            <div ref={tabsRef} role="tablist" aria-label="侧栏标签" className="pane-tabs">
              {tabs.map((tab) => (
                <div
                  role="tab"
                  aria-label={tab.title}
                  tabIndex={state.active === tab.id ? 0 : -1}
                  aria-selected={state.active === tab.id}
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
                  className={`pane-tab ${state.active === tab.id ? "selected" : ""}`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/x-ZPI-pane-tab", tab.id);
                  }}
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes("application/x-ZPI-pane-tab"))
                      event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const id = event.dataTransfer.getData("application/x-ZPI-pane-tab");
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
                    {tab.type === "changes" ? (
                      <Files size={16} />
                    ) : tab.type === "terminal" ? (
                      <TerminalSquare size={16} />
                    ) : tab.type === "file" ? (
                      <FileIcon path={tab.preview.path} />
                    ) : (
                      <Globe size={16} />
                    )}
                    <span>{tab.title}</span>
                  </button>
                  <button
                    className="tab-close"
                    aria-label={`关闭标签 ${tab.title}`}
                    onClick={() => paneTask(closeTab(tab.id))}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
            {tabs.length > 0 && (
              <Dropdown.Root>
                <Dropdown.Trigger asChild>
                  <button className="pane-add-tab" aria-label="新增侧栏标签">
                    <Plus size={16} />
                  </button>
                </Dropdown.Trigger>
                <Dropdown.Portal>
                  <Dropdown.Content className="pane-launcher" align="start" sideOffset={8}>
                    <Dropdown.Item
                      disabled={!sessionId}
                      onSelect={() => {
                        if (sessionId) openChanges(sessionId, null);
                      }}
                    >
                      <Files size={16} />
                      变更
                    </Dropdown.Item>
                    <Dropdown.Item
                      disabled={!sessionId}
                      onSelect={() => {
                        if (sessionId) paneTask(openTerminal(sessionId));
                      }}
                    >
                      <TerminalSquare size={16} />
                      终端
                    </Dropdown.Item>
                    <Dropdown.Item onSelect={() => paneTask(openBrowser("", sessionId))}>
                      <Globe size={16} />
                      浏览器
                    </Dropdown.Item>
                  </Dropdown.Content>
                </Dropdown.Portal>
              </Dropdown.Root>
            )}
            <div className="pane-drag-space" aria-hidden="true" />
          </div>
          {tabs.length === 0 && (
            <div className="pane-empty-launcher">
              <h2>打开标签页</h2>
              <p>选择要在侧栏中打开的标签。</p>
              <div className="pane-launcher-actions">
                <button
                  disabled={!sessionId}
                  onClick={() => {
                    if (sessionId) openChanges(sessionId, null);
                  }}
                >
                  <Files size={16} />
                  变更
                </button>
                <button
                  disabled={!sessionId}
                  onClick={() => {
                    if (sessionId) paneTask(openTerminal(sessionId));
                  }}
                >
                  <TerminalSquare size={16} />
                  终端
                </button>
                <button onClick={() => paneTask(openBrowser("", sessionId))}>
                  <Globe size={16} />
                  浏览器
                </button>
              </div>
            </div>
          )}
          {state.tabs.map((tab) => (
            <div
              key={tab.id}
              className="pane-content"
              role="tabpanel"
              aria-label={tab.title}
              hidden={tab.id !== active}
            >
              {tab.type === "changes" ? (
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
                  visible={state.open && tab.id === active}
                />
              ) : tab.type === "file" ? (
                <FilePane preview={tab.preview} sessionId={tab.sessionId} />
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
