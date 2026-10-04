import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { FileDiff as Files, Globe, Plus, SquareTerminal as TerminalSquare, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { FileIcon } from "zpi-ui";
import { BrowserPane } from "./BrowserPane.tsx";
import { ChangesPane } from "./ChangesPane.tsx";
import { FilePane } from "./FilePane.tsx";
import { closeTab, openBrowser, openChanges, openTerminal, paneTask, usePane } from "./pane-store.ts";
import { TerminalPane } from "./TerminalPane.tsx";
export function RightPane({
  width,
  available,
  sessionId,
}: {
  width: number;
  available: number;
  sessionId?: string;
}) {
  const state = usePane();
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = tabsRef.current?.querySelector<HTMLElement>(".pane-tab.selected");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.active]);
  return (
    <aside className="right-pane" hidden={!state.open} style={{ width }} aria-label="右侧栏">
      <hr
        className="right-resizer"
        aria-label="右侧栏宽度"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={(event) => {
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
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            const ratio = Math.max(
              0.2,
              Math.min(0.7, state.ratio + (event.key === "ArrowLeft" ? 0.03 : -0.03)),
            );
            usePane.setState({ ratio });
            localStorage.setItem("zpi.rightPaneRatio", String(ratio));
          }
        }}
      />
      <div className="pane-header">
        <div ref={tabsRef} role="tablist" aria-label="侧栏标签" className="pane-tabs">
          {state.tabs.map((tab) => (
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
                  const index = state.tabs.findIndex((item) => item.id === tab.id);
                  const next =
                    state.tabs[
                      (index + (event.key === "ArrowRight" ? 1 : -1) + state.tabs.length) % state.tabs.length
                    ];
                  if (next) usePane.setState({ active: next.id });
                }
              }}
              key={tab.id}
              className={`pane-tab ${state.active === tab.id ? "selected" : ""}`}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData("application/x-zpi-pane-tab", tab.id);
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("application/x-zpi-pane-tab")) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData("application/x-zpi-pane-tab");
                const tabs = usePane.getState().tabs;
                const source = tabs.find((item) => item.id === id);
                if (!source || source.id === tab.id) return;
                const reordered = tabs.filter((item) => item.id !== id);
                reordered.splice(
                  tabs.findIndex((item) => item.id === tab.id),
                  0,
                  source,
                );
                usePane.setState({ tabs: reordered });
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
                  if (event.button !== 1) usePane.setState({ active: tab.id });
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
        {state.tabs.length > 0 && (
          <Dropdown.Root>
            <Dropdown.Trigger asChild>
              <button className="pane-add-tab" aria-label="新增侧栏标签" title="新增标签">
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
                <Dropdown.Item onSelect={() => paneTask(openBrowser())}>
                  <Globe size={16} />
                  浏览器
                </Dropdown.Item>
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        )}
        <div className="pane-drag-space" aria-hidden="true" />
      </div>
      {state.tabs.length === 0 && (
        <div className="pane-empty-launcher">
          <h2>打开标签页</h2>
          <p>选择要在侧栏中打开的标签。</p>
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
          <button onClick={() => paneTask(openBrowser())}>
            <Globe size={16} />
            浏览器
          </button>
        </div>
      )}
      {state.tabs.map((tab) => (
        <div
          key={tab.id}
          className="pane-content"
          role="tabpanel"
          aria-label={tab.title}
          hidden={tab.id !== state.active}
        >
          {tab.type === "changes" ? (
            <ChangesPane
              sessionId={tab.sessionId}
              runId={tab.runId}
              path={tab.path}
              visible={state.open && tab.id === state.active}
            />
          ) : tab.type === "terminal" ? (
            <TerminalPane id={tab.id} cwd={tab.cwd} visible={state.open && tab.id === state.active} />
          ) : tab.type === "file" ? (
            <FilePane preview={tab.preview} sessionId={tab.sessionId} />
          ) : (
            <BrowserPane state={tab.state} visible={state.open && tab.id === state.active} />
          )}
        </div>
      ))}
    </aside>
  );
}
