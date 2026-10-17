import { useCallback, useEffect, useRef, useState } from "react";
import { DiffView, type FindRequest, type FindState, ToolFilePreview, useSelectionStableValue } from "zpi-ui";
import type { DiffItem } from "../shared/bridge.ts";
import { PreviewHeader } from "./PreviewHeader.tsx";
import { openFile, paneTask } from "./pane-store.ts";
import { unwrap, useStore } from "./store.ts";
import { userErrorMessage } from "./user-error.ts";
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
    `${sessionId}:${runId}:${toolCallId}:${path}`,
    root,
  );
  const pending = operation?.type === "tool" && ["preparing", "running"].includes(operation.status);
  const previewOperation = operation?.type === "tool" && !operation.fileChange;
  const [entries, setEntries] = useState<DiffItem[]>([]),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!visible || previewOperation) return;
    let active = true;
    setLoading(true);
    setError("");
    const changes =
      toolCallId && path
        ? window.zpi
            .readPatch(sessionId, runId, `operation:${toolCallId}`)
            .then(unwrap)
            .then((patch): DiffItem[] => [
              { id: `operation:${toolCallId}`, path, status: "modified", area: "工具变更", patch },
            ])
        : window.zpi.getChanges(sessionId, runId).then(unwrap);
    void changes
      .then((value) => {
        if (active) setEntries(value);
      })
      .catch((error) => {
        if (active) setError(userErrorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId, runId, revision, visible, toolCallId, path, previewOperation]);
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
          entries={entries}
          renderHeader={(selectedPath, viewSource) => (
            <PreviewHeader sessionId={sessionId} path={selectedPath} onViewSource={viewSource} />
          )}
          initialPath={path}
          loadPatch={load}
          openFile={open}
          findRequest={visible ? findRequest : undefined}
          onFindStateChange={onFindStateChange}
        />
      )}
    </div>
  );
}
