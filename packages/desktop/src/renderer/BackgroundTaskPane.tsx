import { useEffect, useRef, useState } from "react";
import type { BackgroundTaskOutput } from "zpi-ui";
import { paneTask } from "./pane-store.ts";
import { unwrap } from "./store.ts";
import { backgroundStatus } from "./TaskActivity.tsx";
import { userErrorMessage } from "./user-error.ts";

export function BackgroundTaskPane({
  sessionId,
  taskId,
  visible,
}: {
  sessionId: string;
  taskId: string;
  visible: boolean;
}) {
  const [snapshot, setSnapshot] = useState<BackgroundTaskOutput>();
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const output = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = unwrap(await window.zpi.readBackgroundTask(sessionId, taskId));
        if (disposed) return;
        setSnapshot(next);
        setError("");
        if (next.task.status === "running") timer = setTimeout(read, 1000);
      } catch (error) {
        if (!disposed) setError(userErrorMessage(error));
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, taskId, visible]);
  useEffect(() => {
    if (snapshot && following.current && output.current)
      output.current.scrollTop = output.current.scrollHeight;
  }, [snapshot]);
  return (
    <section className="background-task-pane" aria-label="后台任务输出">
      <header>
        <strong>{snapshot ? backgroundStatus[snapshot.task.status] : "读取中"}</strong>
        {snapshot?.task.exitCode != null && <span>退出码 {snapshot.task.exitCode}</span>}
        {snapshot?.task.status === "running" && (
          <button
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              paneTask(
                window.zpi
                  .stopBackgroundTask(sessionId, taskId)
                  .then(unwrap)
                  .finally(() => setStopping(false)),
              );
            }}
          >
            {stopping ? "停止中…" : "停止任务"}
          </button>
        )}
      </header>
      {snapshot && <code className="background-task-command">{snapshot.task.command}</code>}
      {error && <p role="alert">{error}</p>}
      {snapshot?.task.error && <p role="alert">{snapshot.task.error}</p>}
      {snapshot?.truncated && <p>仅显示末尾 64 KiB。完整日志：{snapshot.task.outputPath}</p>}
      <pre
        ref={output}
        onScroll={() => {
          const element = output.current;
          if (element)
            following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        {snapshot?.output || "暂无输出"}
      </pre>
    </section>
  );
}
