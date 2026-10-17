import { useCallback, useEffect, useRef, useState } from "react";
import {
  DiffView,
  type FindRequest,
  type FindState,
  ToolFilePreview,
  toolFile,
  useSelectionStableValue,
} from "zpi-ui";
import type { DiffItem } from "../shared/bridge.ts";
import { PreviewHeader } from "./PreviewHeader.tsx";
import { openFile, paneTask } from "./pane-store.ts";
import { useStore } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";

const emptyEntries: DiffItem[] = [];
export function ChangesPane({
  sessionId,
  runId,
  path,
  toolCallId,
  visible,
  findRequest,
  onFindStateChange,
}: {
  findRequest?: FindRequest;
  onFindStateChange?: (state: FindState) => void;
  sessionId: string;
  runId: string | null;
  path?: string;
  toolCallId?: string;
  visible: boolean;
}) {
  const incomingOperation = useStore((state) =>
    state.views
      .get(sessionId)
      ?.runs.find((run) => run.runId === runId)
      ?.orderedBlocks.find((block) => block.type === "tool" && block.toolCallId === toolCallId),
  );
  const root = useRef<HTMLDivElement>(null);
  const operation = useSelectionStableValue(
    incomingOperation,
    JSON.stringify([sessionId, runId, toolCallId ?? null, path ?? null]),
    root,
  );
  const pending = operation?.type === "tool" && ["preparing", "running"].includes(operation.status);
  const previewOperation = operation?.type === "tool" && !operation.fileChange;
  const previewPath = path || (operation?.type === "tool" ? toolFile(operation)?.path : undefined);
  const scope = JSON.stringify([sessionId, runId, toolCallId ?? null, previewPath ?? null]);
  const [result, setResult] = useState<{
    scope: string;
    entries: DiffItem[];
    error: string;
    loading: boolean;
  }>();
  const [revision, setRevision] = useState(0);
  // 来源切换的首帧也不能露出旧文件；同来源刷新则保留已展示的内容。
  const entries = result?.scope === scope ? result.entries : emptyEntries;
  const error = result?.scope === scope ? result.error : "";
  const loading = result?.scope === scope ? result.loading : visible && !previewOperation;
  useEffect(() => {
    if (!visible || previewOperation) return;
    let active = true;
    setResult((current) => ({
      scope,
      entries: current?.scope === scope ? current.entries : emptyEntries,
      error: "",
      loading: true,
    }));
    const changes = toolCallId
      ? previewPath
        ? window.zpi
            .readPatch(sessionId, runId, `operation:${toolCallId}`)
            .then(unwrap)
            .then((patch): DiffItem[] => [
              {
                id: `operation:${toolCallId}`,
                path: previewPath,
                status: "modified",
                area: "工具变更",
                patch,
              },
            ])
        : Promise.reject(new Error("无法确定此工具变更的文件，请从工具卡片重新打开。"))
      : window.zpi
          .getChanges(sessionId, runId)
          .then(unwrap)
          // initialPath 只是默认选择；先限定数据，才能同时隔离文件导航和搜索。
          .then((value) => (previewPath ? value.filter((entry) => entry.path === previewPath) : value));
    void changes
      .then((value) => {
        if (active) setResult({ scope, entries: value, error: "", loading: false });
      })
      .catch((error) => {
        if (active)
          setResult((current) => ({
            scope,
            entries: current?.scope === scope ? current.entries : emptyEntries,
            error: userErrorMessage(error),
            loading: false,
          }));
      });
    return () => {
      active = false;
    };
  }, [sessionId, runId, revision, visible, toolCallId, previewPath, previewOperation, scope]);
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.zpi.onEvent((event) => {
      if (
        event.sessionId === sessionId &&
        (event.event.type === "settled" || event.event.type === "tool_end")
      ) {
        clearTimeout(timer);
        timer = setTimeout(() => setRevision((n) => n + 1), 200);
      }
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [sessionId, visible]);
  const load = useCallback(
    (id: string) => window.zpi.readPatch(sessionId, runId, id).then(unwrap),
    [sessionId, runId],
  );
  const open = useCallback(
    (id: string) => {
      const entry = entries.find((entry) => entry.id === id);
      if (entry) paneTask(openFile(sessionId, entry.path));
    },
    [sessionId, entries],
  );
  return (
    <div ref={root} className="changes-pane">
      {!pending && error && (
        <p role="alert" className="run-error">
          {error}
        </p>
      )}
      {previewOperation && operation?.type === "tool" ? (
        <div className="pending-file-preview">
          {pending && (
            <p className="pane-empty">
              {operation.status === "preparing" ? "正在生成文件内容…" : "正在写入文件…"}
            </p>
          )}
          <ToolFilePreview block={operation} />
        </div>
      ) : loading && !entries.length ? (
        <p className="pane-empty">加载变更…</p>
      ) : (
        <DiffView
          key={scope}
          entries={entries}
          renderHeader={(selectedPath, viewSource) => (
            <PreviewHeader sessionId={sessionId} path={selectedPath} onViewSource={viewSource} />
          )}
          initialPath={previewPath}
          loadPatch={load}
          openFile={open}
          findRequest={visible ? findRequest : undefined}
          onFindStateChange={onFindStateChange}
        />
      )}
    </div>
  );
}
