// ZCode Explore and ExecuteGroup renderers (872ad96, Apache-2.0).
import { Search, SquareTerminal } from "lucide-react";
import type { LinkContext } from "../link-target.ts";
import { ToolBlock, ToolFileChip } from "./ToolBlock.tsx";
import { ToolLayout } from "./ToolLayout.tsx";
import { groupSummary, type ToolGroupView, toolCommand, toolFile, toolLabel } from "./tool-presentation.ts";

export function ToolGroup({
  group,
  blocks,
  toggle,
  workspace,
  onFile,
  onCopy,
  onChanges,
  onLoadPatch,
}: {
  group: ToolGroupView;
  blocks: Record<string, boolean>;
  toggle: (id: string) => void;
  workspace?: LinkContext;
  onFile?: (path: string) => void;
  onCopy?: (text: string) => Promise<void>;
  onChanges?: (path: string, toolCallId: string) => void;
  onLoadPatch?: (toolCallId: string) => Promise<string>;
}) {
  const expanded = blocks[group.id] ?? false;
  const latest =
    (group.kind === "execute"
      ? group.children.findLast((block) => ["preparing", "running"].includes(block.status))
      : undefined) ?? group.children[group.children.length - 1];
  const file = toolFile(latest, workspace?.cwd);
  const command = toolCommand(latest);
  const summary = groupSummary(group);
  const preview = group.running && !expanded;
  const options = { workspace, onFile, onCopy, onChanges, onLoadPatch };
  return (
    <div className="tool-group" data-testid="tool-group" data-tool-group={group.kind}>
      <ToolLayout
        icon={group.kind === "explore" ? Search : SquareTerminal}
        label={group.kind === "explore" ? "查阅" : "终端"}
        running={group.running}
        expanded={expanded}
        toggle={() => toggle(group.id)}
        separator="·"
        animate={group.kind === "explore" || group.running}
        contentKey={preview ? `${latest.id}:${command || file?.path}` : `summary:${summary}`}
        title={preview ? (file?.path ?? command) : undefined}
        primary={
          preview ? (
            <span className="tool-group-active">
              <span className="tool-active-label">
                {latest.name === "read"
                  ? "正在读取"
                  : latest.name === "bash"
                    ? "正在执行"
                    : toolLabel(latest)}
              </span>
              {file && <ToolFileChip block={latest} {...options} />}
            </span>
          ) : (
            <span className="tool-group-counts">{summary}</span>
          )
        }
        secondary={
          preview ? (
            file?.directory ? (
              <span className="tool-file-directory">{file.directory}</span>
            ) : command ? (
              <code className="tool-command-summary">{command}</code>
            ) : undefined
          ) : undefined
        }
        content={
          <div className="tool-group-children">
            {group.children.map((block) => (
              <ToolBlock
                key={block.id}
                block={block}
                expanded={blocks[block.id] ?? false}
                toggle={() => toggle(block.id)}
                showIcon={false}
                {...options}
              />
            ))}
          </div>
        }
      />
    </div>
  );
}
