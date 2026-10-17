// Adapted from ZCode ExternalAgentImportDialog (Apache-2.0), limited to explicit command import.
import * as Dialog from "@radix-ui/react-dialog";
import { AlertCircle, Check, ChevronRight, LoaderCircle, Minus, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionHint } from "zpi-ui";
import type {
  CommandImportCandidate,
  CommandImportDiscovery,
  CommandImportItemResult,
  CommandImportMode,
  CommandImportResult,
} from "../shared/command-import.ts";
import { SettingsSelect } from "./SettingsSelect.tsx";
import { unwrap } from "./store.ts";
import { useDialogDismiss } from "./use-dialog-dismiss.ts";
import "./command-import.css";

function SelectionBox({
  checked,
  label,
  onToggle,
}: {
  checked: boolean | "mixed";
  label: string;
  onToggle: () => void;
}) {
  return (
    <label className="command-import-checkbox">
      <input
        type="checkbox"
        className="sr-only"
        checked={checked === true}
        aria-checked={checked}
        aria-label={label}
        ref={(input) => {
          if (input) input.indeterminate = checked === "mixed";
        }}
        onChange={onToggle}
      />
      <span data-checked={checked !== false} aria-hidden="true">
        {checked === "mixed" ? <Minus size={14} /> : checked ? <Check size={14} /> : null}
      </span>
    </label>
  );
}
function selectionState(items: CommandImportCandidate[], selected: Set<string>): boolean | "mixed" {
  const count = items.filter((item) => selected.has(item.id)).length;
  return count === 0 ? false : count === items.length ? true : "mixed";
}
function resultLabel(item: CommandImportItemResult): string {
  if (item.status === "imported") {
    return item.method === "copy" ? "已导入（复制）" : "已导入";
  }
  if (item.status === "failed") return `失败：${item.error ?? "无法导入命令"}`;
  return `已跳过：${item.skipReason === "sameNameExists" ? "同名已存在" : "文件已存在"}`;
}

/** Mount only in response to the user's Import action; mounting starts an explicit discovery. */
export function CommandImportDialog({
  onClose,
  onImported,
  projectId,
}: {
  projectId?: string;
  onClose: () => void;
  onImported: () => Promise<void> | void;
}) {
  const [open, close] = useDialogDismiss(onClose);
  const [discovery, setDiscovery] = useState<CommandImportDiscovery>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [sourceScope, setSourceScope] = useState<"global" | "project">("global");
  const [mode, setMode] = useState<CommandImportMode>("symlink");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<CommandImportResult>();
  const [error, setError] = useState("");
  const scanSequence = useRef(0);
  const mounted = useRef(true);
  const importPending = useRef(false);
  const load = useCallback(async () => {
    const sequence = ++scanSequence.current;
    setLoading(true);
    setResult(undefined);
    setSourceScope("global");
    setError("");
    setSelected(new Set());
    setExpanded(new Set());
    try {
      const next = unwrap(await window.zpi.discoverCommandImports(projectId));
      if (mounted.current && scanSequence.current === sequence) setDiscovery(next);
    } catch (error) {
      if (mounted.current && scanSequence.current === sequence) {
        setError(error instanceof Error ? error.message : String(error));
        setDiscovery(undefined);
      }
    } finally {
      if (mounted.current && scanSequence.current === sequence) setLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      scanSequence.current++;
    };
  }, [load]);
  const sources =
    discovery?.sources
      .map((source) => ({ ...source, commands: source.commands.filter((item) => item.importable) }))
      .filter((source) => source.commands.length) ?? [];
  const candidates = sources.flatMap((source) => source.commands);
  const visibleSources = sources.filter((source) => source.scope === sourceScope);
  const visibleCandidates = visibleSources.flatMap((source) => source.commands);
  const allState = selectionState(visibleCandidates, selected);
  const select = (items: CommandImportCandidate[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const item of items) {
        if (checked) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  const startImport = async () => {
    if (!discovery || !selected.size || importPending.current) return;
    importPending.current = true;
    setImporting(true);
    setError("");
    try {
      const imported = unwrap(
        await window.zpi.importCommands(
          {
            scanId: discovery.scanId,
            mode,
            selections: candidates
              .filter((item) => selected.has(item.id))
              .map(({ id, revision }) => ({ id, revision })),
          },
          projectId,
        ),
      );
      if (!mounted.current) return;
      setResult(imported);
      try {
        await onImported();
      } catch {
        setError("导入已完成，但命令列表刷新失败。请重新打开命令设置。");
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      importPending.current = false;
      if (mounted.current) setImporting(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && !importing && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop command-import-backdrop" />
        <Dialog.Content
          className="command-import-dialog"
          onEscapeKeyDown={(event) => {
            event.stopPropagation();
            if (importing) event.preventDefault();
          }}
          onPointerDownOutside={(event) => importing && event.preventDefault()}
        >
          <header className="command-import-header">
            <Dialog.Title>导入外部 Agent 命令</Dialog.Title>
            <Dialog.Description className="sr-only">
              选择外部 Agent 的命令，以软链或直接复制方式导入到所选命令目录。
            </Dialog.Description>
            {!result && !importing && (
              <div className="command-import-header-tools">
                {discovery?.projectAvailable ? (
                  <SettingsSelect<"global" | "project">
                    label="来源范围"
                    value={sourceScope}
                    onChange={setSourceScope}
                    options={[
                      { value: "global", label: "全局" },
                      { value: "project", label: "项目" },
                    ]}
                  />
                ) : (
                  <span>全局</span>
                )}
                <ActionHint appearance="control" label="重新扫描">
                  <button
                    type="button"
                    className="command-import-icon-button"
                    aria-label="重新扫描"
                    disabled={loading}
                    onClick={() => void load()}
                  >
                    <RefreshCw size={12} className={loading ? "command-import-spinner" : undefined} />
                  </button>
                </ActionHint>
              </div>
            )}
            <Dialog.Close className="command-import-icon-button" aria-label="关闭导入" disabled={importing}>
              <X size={14} />
            </Dialog.Close>
          </header>
          <div className="command-import-body">
            {error && (
              <div className="command-import-warning" role="alert">
                {error}
              </div>
            )}
            {loading ? (
              <div className="command-import-loading" role="status">
                <LoaderCircle size={16} className="command-import-spinner" />
                正在扫描可导入命令...
              </div>
            ) : importing ? (
              <div className="command-import-loading" role="status">
                <LoaderCircle size={16} className="command-import-spinner" />
                正在导入命令到 ZPI
              </div>
            ) : result ? (
              <div className="command-import-results">
                <div className="command-import-stats" role="status">
                  <span>
                    <strong>{result.importedCount}</strong> 已导入
                  </span>
                  <span>
                    <strong>{result.skippedCount}</strong> 已跳过
                  </span>
                  <span>
                    <strong>{result.failedCount}</strong> 失败
                  </span>
                </div>
                <h3>命令导入结果</h3>
                <div className="command-import-result-list">
                  {result.items.map((item) => (
                    <div key={item.id} className="command-import-result-row" title={item.sourcePath}>
                      <span
                        className="command-import-result-icon"
                        data-status={item.status}
                        role="img"
                        aria-label={resultLabel(item)}
                        title={resultLabel(item)}
                      >
                        {item.status === "imported" ? (
                          <Check size={9} />
                        ) : item.status === "skipped" ? (
                          <AlertCircle size={10} />
                        ) : (
                          <X size={9} />
                        )}
                      </span>
                      <strong>{item.name}</strong>
                      <span>{resultLabel(item)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : visibleCandidates.length ? (
              <div className="command-import-selection">
                <div className="command-import-select-all">
                  <div>
                    <SelectionBox
                      checked={allState}
                      label={allState === true ? "取消全选" : "全选"}
                      onToggle={() => select(visibleCandidates, allState !== true)}
                    />
                    <span>{allState === true ? "取消全选" : "全选"}</span>
                  </div>
                  <span>
                    已选 {visibleCandidates.filter((item) => selected.has(item.id)).length}/
                    {visibleCandidates.length}
                  </span>
                </div>
                {visibleSources.map((source) => {
                  const state = selectionState(source.commands, selected);
                  const isExpanded = expanded.has(source.id);
                  return (
                    <div key={source.id} className="command-import-source">
                      <div className="command-import-source-row">
                        <SelectionBox
                          checked={state}
                          label={`${state === true ? "取消选择" : "选择"}${source.label}下全部命令`}
                          onToggle={() => select(source.commands, state !== true)}
                        />
                        <button
                          type="button"
                          className="command-import-source-toggle"
                          aria-expanded={isExpanded}
                          aria-label={`${isExpanded ? "折叠" : "展开"}${source.label}命令`}
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(source.id)) next.delete(source.id);
                              else next.add(source.id);
                              return next;
                            })
                          }
                        >
                          <span className="command-import-source-info">
                            <strong>{source.label}</strong>
                            <code>{source.path}</code>
                            <span>{source.commands.length} 个命令</span>
                          </span>
                          <ChevronRight size={14} className={isExpanded ? "expanded" : ""} />
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="command-import-source-items">
                          {source.commands.map((item) => (
                            <div key={item.id} className="command-import-item">
                              <SelectionBox
                                checked={selected.has(item.id)}
                                label={`选择 ${item.name}`}
                                onToggle={() => select([item], !selected.has(item.id))}
                              />
                              <button
                                type="button"
                                className="command-import-item-text"
                                title={item.sourcePath}
                                onClick={() => select([item], !selected.has(item.id))}
                              >
                                <span>
                                  <strong>{item.name}</strong>
                                  {item.argumentHint && <code>{item.argumentHint}</code>}
                                </span>
                                {item.description && <span>{item.description}</span>}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="command-import-empty">
                {candidates.length
                  ? "当前范围下没有可导入命令。"
                  : "暂无可导入命令。可检查外部 Agent 的 commands 目录后重新扫描。"}
              </div>
            )}
            {!loading && !result && discovery?.warnings.length ? (
              <details className="command-import-warnings">
                <summary>有 {discovery.warnings.length} 个文件或目录未能扫描</summary>
                {discovery.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </details>
            ) : null}
          </div>
          <footer className="command-import-footer">
            {result ? (
              <button type="button" className="command-import-primary" onClick={close}>
                完成
              </button>
            ) : (
              <>
                <div className="command-import-footer-info">
                  <span>
                    {loading ? "正在扫描..." : `发现 ${candidates.length} 个可导入命令`}
                    {selected.size > 0 ? ` · 已选 ${selected.size}` : ""}
                  </span>
                  {!importing && (
                    <div className="command-import-mode">
                      <SettingsSelect<CommandImportMode>
                        label="导入方式"
                        value={mode}
                        onChange={setMode}
                        options={[
                          { value: "symlink", label: "软链" },
                          { value: "copy", label: "直接复制" },
                        ]}
                      />
                      <ActionHint
                        appearance="control"
                        label="导入方式说明"
                        className="command-import-mode-tooltip"
                        description={
                          mode === "symlink"
                            ? "创建指向外部 Agent 命令文件的链接，跟随来源后续变更。来源路径须持续可用；编辑会在确认后修改来源文件。Windows 环境需要允许创建软链；不支持时可选择直接复制。"
                            : "将命令文件复制到 ZPI。外部 Agent 文件后续变更不会自动同步。"
                        }
                      >
                        <button type="button" className="command-import-help" aria-label="导入方式说明">
                          <AlertCircle size={12} />
                        </button>
                      </ActionHint>
                    </div>
                  )}
                </div>
                {!importing && (
                  <button
                    type="button"
                    className="command-import-primary"
                    disabled={loading || !selected.size}
                    title={discovery?.targetDirectory ?? "~/.zpi/commands"}
                    onClick={() => void startImport()}
                  >
                    {discovery?.targetScope === "project" ? "导入到项目" : "导入到全局"}
                  </button>
                )}
              </>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
