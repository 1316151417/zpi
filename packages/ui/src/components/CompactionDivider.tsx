// Ported from ZCode v4/ConversationRowView.tsx MarkerDividerRow (Apache-2.0).
import { Archive } from "lucide-react";
import type { CompactionView } from "../types.ts";

export function CompactionDivider({ marker }: { marker: CompactionView }) {
  const running = marker.status === "running";
  const label = {
    running: "正在压缩上下文",
    completed: marker.origin === "auto" ? "上下文已自动压缩" : "上下文已压缩",
    aborted: "上下文压缩已中断",
    interrupted: "上下文压缩已中断",
    error: "上下文压缩失败",
    noop: "上下文已是最新，无需压缩",
  }[marker.status];
  return (
    <div
      className="compaction-divider"
      data-testid="compaction-divider"
      data-status={marker.status}
      data-origin={marker.origin}
      role="status"
      title={marker.error}
    >
      <span aria-hidden="true" className="compaction-line" />
      <span className="compaction-label">
        {!running && <Archive size={14} aria-hidden="true" />}
        <span className={running ? "thinking-label-streaming" : undefined}>{label}</span>
      </span>
      <span aria-hidden="true" className="compaction-line" />
    </div>
  );
}
