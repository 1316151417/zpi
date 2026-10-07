import { DiffView, type FindRequest, type FindState } from "ZPI-ui";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DiffItem } from "../shared/bridge.ts";
import { openFile, paneTask } from "./pane-store.ts";
import { unwrap } from "./store.ts";
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
  const [entries, setEntries] = useState<DiffItem[]>([]),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setLoading(true);
    setError("");
    const changes =
      toolCallId && path
        ? window.ZPI.readPatch(sessionId, runId, `operation:${toolCallId}`)
            .then(unwrap)
            .then((patch): DiffItem[] => [
              { id: `operation:${toolCallId}`, path, status: "modified", area: "工具变更", patch },
            ])
        : window.ZPI.getChanges(sessionId, runId).then(unwrap);
    void changes
      .then((value) => {
        if (active) setEntries(value);
      })
      .catch((error) => {
        if (active) setError(String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId, runId, revision, visible, toolCallId, path]);
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.ZPI.onEvent((event) => {
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
    (id: string) => window.ZPI.readPatch(sessionId, runId, id).then(unwrap),
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
    <div className="changes-pane">
      <div className="pane-subheading">
        <span>
          {toolCallId ? "工具变更" : runId ? "本轮变更" : "任务变更"} ·{" "}
          {new Set(entries.map((entry) => entry.path)).size} 个文件
        </span>
        <button aria-label="刷新变更" disabled={loading} onClick={() => setRevision((n) => n + 1)}>
          <RefreshCw size={14} />
        </button>
      </div>
      {error && (
        <p role="alert" className="run-error">
          {error}
        </p>
      )}
      {loading && !entries.length ? (
        <p className="pane-empty">加载变更…</p>
      ) : (
        <DiffView
          entries={entries}
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
