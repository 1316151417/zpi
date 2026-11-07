import { ArrowLeft, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type ConfiguredHook, configurableHookEvents, type SaveHookInput } from "../shared/hooks.ts";
import { SettingsSelect } from "./SettingsSelect.tsx";

const matcherEvents = new Set([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
]);
export function HookForm({
  hook,
  projectId,
  scopeControl,
  saving,
  error,
  onSave,
  onCancel,
  onDelete,
}: {
  hook?: ConfiguredHook;
  projectId: string | null;
  scopeControl: ReactNode;
  saving: boolean;
  error: string;
  onSave(input: SaveHookInput): void;
  onCancel(): void;
  onDelete(hook: ConfiguredHook): void;
}) {
  const [event, setEvent] = useState(hook?.event ?? "PreToolUse");
  const [type, setType] = useState<"command" | "process">(hook?.type ?? "process");
  const [command, setCommand] = useState(hook?.command ?? "");
  const [args, setArgs] = useState(hook?.args.join("\n") ?? "");
  const [matcher, setMatcher] = useState(hook?.matcher ?? "");
  const [timeout, setTimeout] = useState(String((hook?.timeoutMs ?? 60000) / 1000));
  let matcherError = "";
  if (matcherEvents.has(event) && matcher && matcher !== "*") {
    try {
      new RegExp(matcher);
    } catch {
      matcherError = "匹配规则必须是有效的正则表达式。";
    }
  }
  const timeoutMs = Number(timeout) * 1000;
  const valid =
    command.trim() &&
    !matcherError &&
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs >= 1 &&
    timeoutMs <= 300000;
  return (
    <form
      className="hook-form"
      aria-label={hook ? "编辑钩子" : "新建钩子"}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || saving) return;
        onSave({
          event,
          type,
          command,
          args: type === "process" && args ? args.split(/\r?\n/) : [],
          ...(matcherEvents.has(event) && matcher ? { matcher } : {}),
          timeoutMs,
          enabled: hook?.enabled ?? true,
          projectId,
          ...(hook ? { id: hook.id, expectedRevision: hook.revision } : {}),
        });
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (!saving) onCancel();
        }
      }}
    >
      <button type="button" className="hook-back" onClick={onCancel} disabled={saving}>
        <ArrowLeft size={16} />
        返回钩子列表
      </button>
      <div className="hook-form-heading">
        <h3>{hook ? "编辑钩子" : "新建钩子"}</h3>
        <p>在任务生命周期事件中运行命令。</p>
      </div>
      <div className="hook-form-panel">
        <div className="hook-form-top">
          <div className="hook-form-columns">
            <div className="hook-field">
              <label htmlFor="hook-event">触发事件</label>
              <SettingsSelect<ConfiguredHook["event"]>
                id="hook-event"
                label="触发事件"
                value={event}
                disabled={saving}
                options={configurableHookEvents.map((value) => ({ value, label: value }))}
                onChange={setEvent}
              />
            </div>
            <div className="hook-field">
              <label htmlFor="hook-type">执行方式</label>
              <SettingsSelect<"process" | "command">
                id="hook-type"
                label="执行方式"
                value={type}
                disabled={saving}
                options={[
                  { value: "process", label: "进程（process）" },
                  { value: "command", label: "命令（command）" },
                ]}
                onChange={setType}
              />
            </div>
          </div>
          <span className="hook-form-scope">范围 {scopeControl}</span>
        </div>
        <div className="hook-form-columns">
          <div className="hook-field">
            <label htmlFor="hook-matcher">匹配规则</label>
            <input
              id="hook-matcher"
              value={matcher}
              onChange={(e) => setMatcher(e.target.value)}
              disabled={saving || !matcherEvents.has(event)}
              placeholder="例如 Bash|Edit|Write"
            />
            <p>
              {matcherError ||
                (matcherEvents.has(event)
                  ? "工具名、会话来源或通知类型的正则表达式，留空匹配全部。"
                  : "此事件不需要匹配规则。")}
            </p>
          </div>
          <div className="hook-field">
            <label htmlFor="hook-command">{type === "process" ? "可执行程序" : "命令"}</label>
            <input
              id="hook-command"
              className="hook-code"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              disabled={saving}
              placeholder={type === "process" ? "例如 python3" : "例如 python3 /path/to/check.py"}
              maxLength={16000}
            />
          </div>
        </div>
        {type === "process" && (
          <div className="hook-field">
            <label htmlFor="hook-args">参数</label>
            <textarea
              id="hook-args"
              className="hook-code"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              disabled={saving}
              rows={4}
            />
            <p>每行一个参数，无需添加引号；空行表示空参数。</p>
          </div>
        )}
        <details className="hook-advanced">
          <summary>高级设置</summary>
          <div className="hook-field">
            <label htmlFor="hook-timeout">超时（秒）</label>
            <input
              id="hook-timeout"
              type="number"
              min="0.001"
              max="300"
              step="0.001"
              value={timeout}
              onChange={(e) => setTimeout(e.target.value)}
              disabled={saving}
            />
            <p>超时或任务取消时停止命令，最长 300 秒。</p>
          </div>
        </details>
        {error && (
          <p role="alert" className="run-error">
            {error}
          </p>
        )}
        <footer className="hook-form-actions">
          {hook && (
            <button type="button" className="hook-delete" onClick={() => onDelete(hook)} disabled={saving}>
              <Trash2 size={14} />
              删除
            </button>
          )}
          <button type="submit" className="primary plugin-add" disabled={!valid || saving}>
            保存
          </button>
          <button type="button" className="plugin-add" onClick={onCancel} disabled={saving}>
            取消
          </button>
        </footer>
      </div>
    </form>
  );
}
