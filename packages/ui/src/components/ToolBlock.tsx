// ZCode read/execute/edit renderers, adapted to ZPI's four tools (Apache-2.0).
import { Pencil, Search, SquareTerminal, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import type { LinkContext } from "../link-target.ts";
import { FlipMetricValue } from "./FlipMetricValue.tsx";
import { FileIcon } from "./Reference.tsx";
import { ToolCode, ToolDiff } from "./ToolDiff.tsx";
import { ToolFailure } from "./ToolFailure.tsx";
import { ToolLayout } from "./ToolLayout.tsx";
import { ToolOutput } from "./ToolOutput.tsx";
import {
  executionCommand,
  type ToolView,
  toolCommand,
  toolFile,
  toolInput,
  toolLabel,
} from "./tool-presentation.ts";

export interface ToolBlockProps {
  block: ToolView;
  expanded: boolean;
  toggle: () => void;
  showIcon?: boolean;
  workspace?: LinkContext;
  onFile?: (path: string) => void;
  onCopy?: (text: string) => Promise<void>;
  onChanges?: (path: string, toolCallId: string) => void;
  onLoadPatch?: (toolCallId: string) => Promise<string>;
}

export function ToolFileChip({
  block,
  workspace,
  onFile,
  onChanges,
}: Pick<ToolBlockProps, "block" | "workspace" | "onFile" | "onChanges">) {
  const file = toolFile(block, workspace?.cwd);
  if (!file) return null;
  const open =
    block.fileChange && onChanges
      ? () => onChanges(file.path, block.toolCallId)
      : onFile
        ? () => onFile(file.path)
        : undefined;
  const contents = (
    <>
      <FileIcon path={file.path} />
      <span>{file.name}</span>
    </>
  );
  return open ? (
    <button
      type="button"
      className="tool-file-chip"
      title={file.path}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {contents}
    </button>
  ) : (
    <span className="tool-file-chip" title={file.path}>
      {contents}
    </span>
  );
}

function FileToolDetails({ block, onLoadPatch }: Pick<ToolBlockProps, "block" | "onLoadPatch">) {
  const [patch, setPatch] = useState(block.fileChange?.patch);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setPatch(block.fileChange?.patch);
    setError("");
    if (!block.fileChange?.patchAvailable || !onLoadPatch) return;
    void onLoadPatch(block.toolCallId)
      .then((text) => {
        if (active) setPatch(text);
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [block.toolCallId, block.fileChange, onLoadPatch]);
  return (
    <div className="tool-file-details">
      {patch ? (
        <ToolDiff
          patch={patch}
          path={block.fileChange?.path ?? toolFile(block)?.path ?? ""}
          selectionKey={block.id}
        />
      ) : block.fileChange?.patchAvailable && !error ? (
        <p className="tool-detail-note">正在加载...</p>
      ) : (
        <div className="tool-parameters">
          <h4>Parameters</h4>
          <div className="tool-parameters-code">
            <ToolCode text={JSON.stringify(toolInput(block), null, 2)} />
          </div>
        </div>
      )}
      {(error || block.fileChange?.reason) && (
        <p role={error ? "alert" : undefined} className="tool-detail-note">
          {error || block.fileChange?.reason}
        </p>
      )}
      {block.status === "error" && (
        <div className="tool-detail-error">
          <h4>Error</h4>
          <pre>{block.output}</pre>
        </div>
      )}
    </div>
  );
}

export function ToolBlock(props: ToolBlockProps) {
  const { block, expanded, toggle, workspace, onCopy, showIcon = true } = props;
  const running = block.status === "preparing" || block.status === "running";
  const file = toolFile(block, workspace?.cwd);
  const command = toolCommand(block);
  // Pi 的无输出占位只用于模型协议；界面使用 ZCode 的完成态文案。
  const output = !running && block.output === "(no output)" ? "" : block.output;
  const bash = block.name === "bash";
  const read = block.name === "read";
  const change = block.fileChange;
  const trailing =
    change && ((change.additions ?? 0) > 0 || (change.deletions ?? 0) > 0) ? (
      <span className="tool-diff-counts">
        {(change.additions ?? 0) > 0 && (
          <span className="diff-added">
            +<FlipMetricValue value={String(change.additions)} />
          </span>
        )}
        {(change.deletions ?? 0) > 0 && (
          <span className="diff-removed">
            -<FlipMetricValue value={String(change.deletions)} />
          </span>
        )}
      </span>
    ) : undefined;
  return (
    <div className="tool-block" data-testid="tool-block" data-tool-name={block.name}>
      <ToolLayout
        icon={
          read ? Search : bash ? SquareTerminal : ["edit", "write"].includes(block.name) ? Pencil : Wrench
        }
        label={toolLabel(block)}
        running={running}
        showIcon={showIcon}
        expanded={!read && expanded}
        toggle={read ? undefined : toggle}
        prioritize={!bash}
        title={file?.path}
        primary={file ? <ToolFileChip {...props} /> : !bash ? block.name : undefined}
        secondary={
          bash ? (
            !expanded && command ? (
              <code className="tool-command-summary">{command}</code>
            ) : undefined
          ) : file?.directory ? (
            <span className="tool-file-directory">{file.directory}</span>
          ) : undefined
        }
        trailing={trailing}
        failure={
          block.status === "error" ? (
            <ToolFailure text={block.output || "工具执行失败"} onCopy={onCopy} />
          ) : undefined
        }
        content={
          bash ? (
            <div className="tool-details">
              <div className="tool-command-line">
                <span className="tool-prompt">$</span>
                <pre
                  className="tool-command"
                  data-conversation-selectable="tool"
                  data-selection-key={`${block.id}:args`}
                >
                  {executionCommand(command)}
                </pre>
              </div>
              {output ? (
                <ToolOutput text={output} running={running} selectionKey={block.id} />
              ) : (
                !running && <p className="tool-no-output">没有输出。</p>
              )}
            </div>
          ) : (
            <FileToolDetails block={block} onLoadPatch={props.onLoadPatch} />
          )
        }
      />
    </div>
  );
}
