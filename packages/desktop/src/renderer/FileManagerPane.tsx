import { FolderOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import type { FindRequest, FindState } from "zpi-ui";
import { ChangesPane } from "./ChangesPane.tsx";
import { FilePane } from "./FilePane.tsx";
import type { FilePaneTab } from "./pane-store.ts";
import { navigateFileManager, paneTask } from "./pane-store.ts";
import { useWorkspace } from "./use-workspace.ts";
import { WorkspaceFileTree } from "./workspace-file-tree/WorkspaceFileTree.tsx";
import "./workspace-file-tree/file-tree.css";

const navigationListeners = new Set<() => void>();
const navigationKey = "zpi.fileManagerNavigation";
function navigationPreference(cwd: string): boolean {
  try {
    return JSON.parse(localStorage.getItem(navigationKey) ?? "{}")[cwd] ?? true;
  } catch {
    return true;
  }
}
function saveNavigationPreference(cwd: string, open: boolean) {
  let preferences: Record<string, boolean> = {};
  try {
    preferences = JSON.parse(localStorage.getItem(navigationKey) ?? "{}");
  } catch {}
  localStorage.setItem(navigationKey, JSON.stringify({ ...preferences, [cwd]: open }));
  for (const listener of navigationListeners) listener();
}
function subscribeNavigation(listener: () => void) {
  navigationListeners.add(listener);
  return () => navigationListeners.delete(listener);
}
export function FileManagerPane({
  tab,
  visible,
  findRequest,
  onFindStateChange,
}: {
  tab: FilePaneTab;
  visible: boolean;
  findRequest?: FindRequest;
  onFindStateChange?: (state: FindState) => void;
}) {
  const workspace = useWorkspace(tab.cwd ? undefined : tab.sessionId);
  const cwd = tab.cwd ?? workspace?.cwd ?? "";
  const preview = tab.type === "changes" ? undefined : tab.preview;
  const path = tab.type === "changes" ? tab.path : preview?.path;
  const canNavigate = Boolean(cwd && (tab.type === "file-manager" || path));
  const container = useRef<HTMLDivElement>(null);
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  const [minimumSize, setMinimumSize] = useState(160);
  const directoryPanel = usePanelRef();
  const { defaultLayout, onLayoutChange } = useDefaultLayout({
    id: "zpi.file-manager-layout",
    panelIds: ["preview", "directory"],
  });
  const preference = useSyncExternalStore(subscribeNavigation, () => navigationPreference(cwd));
  const navigationOpen = canNavigate && preference;
  const revealPath = tab.type === "file-manager" ? tab.revealPath : undefined;
  useLayoutEffect(() => {
    if (revealPath) saveNavigationPreference(cwd, true);
  }, [cwd, revealPath]);
  useLayoutEffect(() => {
    if (!visible) return;
    const updateLayout = () => {
      if (navigationOpen) directoryPanel.current?.expand();
      else directoryPanel.current?.collapse();
    };
    updateLayout();
    // Resizing re-registers the panel constraints; apply visibility after that commit as well.
    const frame = requestAnimationFrame(updateLayout);
    return () => cancelAnimationFrame(frame);
  }, [navigationOpen, minimumSize, visible, directoryPanel]);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      // Keep both desktop columns resizable even when their usual 160px minimums would not fit.
      if (entry && entry.contentRect.width > 0)
        setMinimumSize(Math.min(160, Math.floor(entry.contentRect.width / 3)));
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const label = navigationOpen ? "收起文件导航" : "显示文件导航";
  return (
    <div
      ref={container}
      className="file-manager"
      data-file-manager-pane=""
      data-navigation-open={navigationOpen}
    >
      <div className="file-manager-toolbar">
        <div ref={setHeader} className="file-manager-preview-header">
          {tab.type === "file-manager" && !preview && <span className="file-manager-title">文件</span>}
        </div>
        {canNavigate && (
          <div className="file-manager-toggle">
            <button
              type="button"
              title={label}
              aria-label={label}
              aria-expanded={navigationOpen}
              onClick={() => {
                saveNavigationPreference(cwd, !navigationOpen);
              }}
            >
              {navigationOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
          </div>
        )}
      </div>
      <Group
        className="file-manager-split"
        defaultLayout={defaultLayout}
        onLayoutChange={onLayoutChange}
        disabled={!navigationOpen}
      >
        <Panel id="preview" minSize={minimumSize} className="file-manager-preview">
          {tab.type === "changes" ? (
            <ChangesPane
              sessionId={tab.sessionId}
              runId={tab.runId}
              path={tab.path}
              toolCallId={tab.toolCallId}
              visible={visible}
              findRequest={findRequest}
              onFindStateChange={onFindStateChange}
              headerContainer={header}
              workspaceCwd={cwd}
            />
          ) : preview ? (
            <FilePane
              preview={preview}
              sessionId={tab.sessionId}
              headerContainer={header}
              workspaceCwd={cwd}
            />
          ) : (
            <div className="file-manager-empty">
              <FolderOpen size={24} />
              <span>从目录中选择一个文件</span>
            </div>
          )}
        </Panel>
        <Separator className="file-manager-resizer" hidden={!navigationOpen} aria-label="调整文件目录宽度" />
        <Panel
          id="directory"
          panelRef={directoryPanel}
          collapsible
          collapsedSize="0px"
          defaultSize="192px"
          minSize={minimumSize}
          maxSize="60%"
          className="file-manager-directory"
        >
          {canNavigate && (
            <WorkspaceFileTree
              sessionId={tab.sessionId}
              workspacePath={cwd}
              workspaceName={
                tab.type === "file-manager" ? tab.workspaceName : cwd.split(/[\\/]/).at(-1) || "Workspace"
              }
              activePreviewPath={path ?? (tab.type === "file-manager" ? tab.revealPath : undefined)}
              onOpenPreview={(path) => {
                paneTask(navigateFileManager(tab.id, path));
              }}
            />
          )}
        </Panel>
      </Group>
    </div>
  );
}
