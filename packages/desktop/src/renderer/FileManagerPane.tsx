import { FolderOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { FilePane } from "./FilePane.tsx";
import type { PaneTab } from "./pane-store.ts";
import { navigateFileManager, paneTask } from "./pane-store.ts";
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
export function FileManagerPane({ tab }: { tab: Extract<PaneTab, { type: "file-manager" }> }) {
  const container = useRef<HTMLDivElement>(null);
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [compactOpen, setCompactOpen] = useState<boolean | null>(null);
  const previewPanel = usePanelRef();
  const directoryPanel = usePanelRef();
  const { defaultLayout, onLayoutChange } = useDefaultLayout({
    id: "zpi.file-manager-layout",
    panelIds: ["preview", "directory"],
  });
  const preference = useSyncExternalStore(subscribeNavigation, () => navigationPreference(tab.cwd));
  const navigationOpen = narrow ? (compactOpen ?? preference) : preference;
  const navigationOnly = narrow && navigationOpen;
  useLayoutEffect(() => {
    if (navigationOnly) previewPanel.current?.collapse();
    else previewPanel.current?.expand();
    if (navigationOpen) directoryPanel.current?.expand();
    else directoryPanel.current?.collapse();
  }, [navigationOnly, navigationOpen, previewPanel, directoryPanel]);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setNarrow(entry.contentRect.width < 384);
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
      data-navigation-only={navigationOnly}
      data-navigation-open={navigationOpen}
    >
      <div className="file-manager-toolbar">
        <div ref={setHeader} className="file-manager-preview-header">
          {!tab.preview && <span className="file-manager-title">文件</span>}
        </div>
        <div className="file-manager-toggle">
          <button
            type="button"
            title={label}
            aria-label={label}
            aria-expanded={navigationOpen}
            onClick={() => {
              saveNavigationPreference(tab.cwd, !navigationOpen);
              setCompactOpen(null);
            }}
          >
            {navigationOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
        </div>
      </div>
      <Group
        className="file-manager-split"
        defaultLayout={defaultLayout}
        onLayoutChange={onLayoutChange}
        disabled={!navigationOpen || narrow}
      >
        <Panel
          id="preview"
          panelRef={previewPanel}
          collapsible
          collapsedSize="0px"
          minSize="160px"
          className="file-manager-preview"
        >
          {tab.preview ? (
            <FilePane
              preview={tab.preview}
              sessionId={tab.sessionId}
              headerContainer={header}
              workspaceCwd={tab.cwd}
            />
          ) : (
            <div className="file-manager-empty">
              <FolderOpen size={24} />
              <span>从目录中选择一个文件</span>
            </div>
          )}
        </Panel>
        <Separator
          className="file-manager-resizer"
          hidden={!navigationOpen || narrow}
          aria-label="调整文件目录宽度"
        />
        <Panel
          id="directory"
          panelRef={directoryPanel}
          collapsible
          collapsedSize="0px"
          defaultSize="192px"
          minSize="160px"
          maxSize={navigationOnly ? "100%" : "60%"}
          className="file-manager-directory"
        >
          <WorkspaceFileTree
            sessionId={tab.sessionId}
            workspacePath={tab.cwd}
            workspaceName={tab.workspaceName}
            activePreviewPath={tab.preview?.path}
            onOpenPreview={(path) => {
              paneTask(navigateFileManager(tab.id, path));
              if (narrow) setCompactOpen(false);
            }}
          />
        </Panel>
      </Group>
    </div>
  );
}
