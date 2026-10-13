// Adapted from ZCode's task-output and task-stop renderers (Apache-2.0).
import { CircleStop, FileOutput } from "lucide-react";
import type { ToolBlockProps } from "./ToolBlock.tsx";
import { ToolFailure } from "./ToolFailure.tsx";
import { ToolLayout } from "./ToolLayout.tsx";
import { toolInput } from "./tool-presentation.ts";

export function SubagentTaskToolBlock({ block, expanded, toggle, onCopy, showIcon }: ToolBlockProps) {
  const input = toolInput(block);
  const stop = block.name === "TaskStop";
  const running = block.status === "preparing" || block.status === "running";
  const taskId = typeof input.task_id === "string" ? input.task_id : block.name;
  // Match the envelope once; XML-like text inside a result is ordinary task output.
  const envelope =
    /^<retrieval_status>(\w+)<\/retrieval_status>\n\n<task_id>[^\n]+<\/task_id>\n\n<task_type>(?:local_agent|local_bash)<\/task_type>\n\n<status>(\w+)<\/status>(?:\n\n<exit_code>-?\d+<\/exit_code>)?(?:\n\n<output>\n([\s\S]*)\n<\/output>)?(?:\n\n<error>([\s\S]*)<\/error>)?$/.exec(
      block.output,
    );
  const retrieval = envelope?.[1];
  const status = envelope?.[2];
  let output = envelope?.[3] ?? "";
  if (stop && block.status !== "error") {
    try {
      const result = JSON.parse(block.output);
      output = [result.command, result.message].filter((value) => typeof value === "string").join("\n");
    } catch {
      output = block.output;
    }
  }
  const outcome = running
    ? undefined
    : stop
      ? "已停止"
      : retrieval === "timeout"
        ? "等待超时"
        : retrieval === "not_ready"
          ? "运行中"
          : ["error", "failed"].includes(status ?? "")
            ? "任务失败"
            : ["aborted", "cancelled"].includes(status ?? "")
              ? "任务已停止"
              : ["interrupted", "lost"].includes(status ?? "")
                ? "任务已中断"
                : retrieval === "success"
                  ? "已读取"
                  : undefined;
  const failure = block.status === "error" ? block.output : envelope?.[4];
  return (
    <div className="tool-block" data-testid="tool-block" data-tool-name={block.name}>
      <ToolLayout
        icon={stop ? CircleStop : FileOutput}
        showIcon={showIcon}
        label={stop ? (running ? "正在停止任务" : "停止任务") : running ? "正在读取输出" : "任务输出"}
        running={running}
        expanded={!!output && expanded}
        toggle={output ? toggle : undefined}
        primary={<code className="tool-summary-text">{taskId}</code>}
        trailing={!failure && outcome ? <span className="tool-summary-status">{outcome}</span> : undefined}
        failure={failure ? <ToolFailure text={failure} onCopy={onCopy} /> : undefined}
        content={
          <pre
            className="subagent-task-output"
            data-conversation-selectable="tool"
            data-selection-key={block.id}
          >
            {output}
          </pre>
        }
      />
    </div>
  );
}
