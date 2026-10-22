// ZCode Agent summary: a single row opens the complete child timeline in the side pane.
import { Bot } from "lucide-react";
import { createContext, useContext } from "react";
import type { SubagentTask } from "../types.ts";
import type { ToolBlockProps } from "./ToolBlock.tsx";
import { ToolFailure } from "./ToolFailure.tsx";
import { ToolLayout } from "./ToolLayout.tsx";
import { toolInput, toolLabel } from "./tool-presentation.ts";

export const SubagentContext = createContext<{ tasks: SubagentTask[]; open?: (task: SubagentTask) => void }>({
  tasks: [],
});
export const subagentStatusLabels: Record<SubagentTask["status"], string> = {
  running: "运行中",
  completed: "已完成",
  aborted: "已停止",
  error: "失败",
  interrupted: "已中断",
};

function activitySummary(activity: string): string {
  // 活动快照保留原始工具名；在展示层统一文案，历史记录也能生效，命令中的分隔符保持原样。
  const separator = activity.indexOf(" · ");
  if (separator < 0) return activity;
  const name = activity.slice(0, separator);
  const label = toolLabel({ name, status: "running" });
  return `${label === name ? "正在运行" : label}${activity.slice(separator)}`;
}

export function SubagentToolBlock({ block, onCopy }: ToolBlockProps) {
  const { tasks, open } = useContext(SubagentContext);
  const task = tasks.find((task) => task.parentToolCallId === block.toolCallId);
  const input = toolInput(block);
  const name =
    task?.agentType ??
    (typeof input.subagent_type === "string"
      ? input.subagent_type
      : block.status === "preparing"
        ? ""
        : "general-purpose");
  const title = task?.description ?? (typeof input.description === "string" ? input.description : "子智能体");
  const running = block.status === "preparing" || block.status === "running";
  const primary = running && task?.latestActivity ? activitySummary(task.latestActivity) : title;
  return (
    <div className="tool-block subagent-tool-block" data-testid="tool-block" data-tool-name="Agent">
      <ToolLayout
        icon={Bot}
        label="子智能体"
        running={running}
        expanded={false}
        kindDetail={
          name ? (
            <span
              className="subagent-name"
              data-agent-color={task?.color ?? (name === "Explore" ? "cyan" : "blue")}
            >
              {name}
            </span>
          ) : undefined
        }
        primary={<span className="subagent-summary-text">{primary}</span>}
        separator="·"
        title={title}
        animate
        contentKey={primary}
        summaryAction={task && open ? () => open(task) : undefined}
        summaryLabel={`在侧栏查看 ${title}`}
        failure={
          block.status === "error" ? (
            <ToolFailure text={block.output || "子智能体执行失败"} onCopy={onCopy} />
          ) : undefined
        }
      />
    </div>
  );
}
