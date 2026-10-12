// ZCode local-agent message renderers: public input details, no transport payloads.
import { Reply, Send } from "lucide-react";
import type { ToolBlockProps } from "./ToolBlock.tsx";
import { ToolFailure } from "./ToolFailure.tsx";
import { ToolLayout } from "./ToolLayout.tsx";
import { toolInput } from "./tool-presentation.ts";

export function SubagentMessageToolBlock({ block, expanded, toggle, onCopy }: ToolBlockProps) {
  const input = toolInput(block);
  const reply = block.name === "RespondToCoordinator";
  const running = block.status === "preparing" || block.status === "running";
  const summary = typeof input.summary === "string" ? input.summary : "";
  const target = typeof input.to === "string" ? input.to : "";
  const message = typeof input.message === "string" ? input.message : "";
  const details = !reply && Boolean(summary || target || message);
  return (
    <div className="tool-block" data-testid="tool-block" data-tool-name={block.name}>
      <ToolLayout
        icon={reply ? Reply : Send}
        label={reply ? (running ? "正在回复" : "回复") : running ? "正在发送消息" : "消息"}
        running={running}
        expanded={details && expanded}
        toggle={details ? toggle : undefined}
        separator="·"
        primary={summary || block.name}
        secondary={
          !reply && target ? (
            <span>
              到 <code>{target}</code>
            </span>
          ) : undefined
        }
        trailing={reply && !running && block.status !== "error" ? "回复已排队" : undefined}
        failure={
          block.status === "error" ? (
            <ToolFailure
              text={reply ? "回复投递失败，请重试。" : block.output || "消息发送失败"}
              onCopy={onCopy}
            />
          ) : undefined
        }
        content={
          <dl className="subagent-message-details">
            {[
              ["目标", target],
              ["摘要", summary],
              ["消息", message],
            ]
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
          </dl>
        }
      />
    </div>
  );
}
