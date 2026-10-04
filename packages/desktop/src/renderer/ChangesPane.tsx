import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DiffView } from "zpi-ui";
import type { DiffItem } from "../shared/bridge.ts";
import { openFile, paneTask } from "./pane-store.ts";
import { unwrap } from "./store.ts";
export function ChangesPane({
  sessionId,
  runId,
  path,
  visible,
}: {
  sessionId: string;
  runId: string | null;
  path?: string;
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
    void window.zpi
      .getChanges(sessionId, runId)
      .then(unwrap)
      .then((value) => {
        if (active) setEntries(value);
      })
      .catch((error) => {
        if (active) setError(String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const off = window.zpi.onEvent((event) => {
      if (
        event.sessionId === sessionId &&
        (event.event.type === "settled" || event.event.type === "tool_end")
      )
        setRevision((n) => n + 1);
    });
    return () => {
      active = false;
      off();
    };
  }, [sessionId, runId, revision, visible]);
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
    <div className="changes-pane">
      <div className="pane-subheading">
        <span>
          {runId ? "本轮变更" : "任务变更"} · {new Set(entries.map((entry) => entry.path)).size} 个文件
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
        <DiffView entries={entries} initialPath={path} loadPatch={load} openFile={open} />
      )}
    </div>
  );
}
