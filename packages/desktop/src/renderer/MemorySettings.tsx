import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CombinedSelection, ProviderRecord } from "../shared/bridge.ts";
import { defaultPreset, modelReasoningLabel } from "../shared/config.ts";
import {
  type MemorySettings as MemorySettingsData,
  type MemoryStatus,
  memorySettingLimits,
} from "../shared/memory.ts";
import { quickChatModels } from "../shared/quick-chat-settings.ts";
import { SettingsHelp } from "./SettingsHelp.tsx";
import { SettingsSelect } from "./SettingsSelect.tsx";
import { selectSession, useStore } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";
import "./memory-settings.css";

const modelKey = (selection: { provider: string; modelId: string }) =>
  JSON.stringify([selection.provider, selection.modelId]);

/** Shared by the default model and the two optional stage overrides; never falls back silently. */
function MemoryModelSelection({
  label,
  value,
  providers,
  disabled,
  optional = false,
  onChange,
}: {
  label: string;
  value: CombinedSelection | null;
  providers: ProviderRecord[];
  disabled: boolean;
  optional?: boolean;
  onChange: (value: CombinedSelection | null) => void;
}) {
  const models = quickChatModels(providers);
  const selected = models.find(
    ({ provider, model }) => provider.id === value?.provider && model.id === value?.modelId,
  );
  const valid = !!selected && !!value && selected.presets.includes(value.reasoning);
  return (
    <>
      <div className="settings-row">
        <span className="settings-row-copy">
          <strong>{label}</strong>
        </span>
        <SettingsSelect
          label={label}
          value={value ? (selected ? modelKey(value) : "unavailable") : "inherit"}
          disabled={disabled}
          options={[
            { value: "inherit", label: optional ? "跟随本批默认模型" : "请选择模型" },
            ...(value && !selected
              ? [{ value: "unavailable", label: `${value.provider} / ${value.modelId}（不可用）` }]
              : []),
            ...models.map(({ provider, model }) => ({
              value: modelKey({ provider: provider.id, modelId: model.id }),
              label: `${provider.name} · ${model.name || model.id}`,
            })),
          ]}
          onChange={(key) => {
            if (key === "inherit") onChange(null);
            else {
              const next = models.find(
                ({ provider, model }) => modelKey({ provider: provider.id, modelId: model.id }) === key,
              );
              if (next)
                onChange({
                  provider: next.provider.id,
                  modelId: next.model.id,
                  reasoning: defaultPreset(next.model),
                });
            }
          }}
        />
      </div>
      {value && selected && (
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>{label}思考级别</strong>
          </span>
          <SettingsSelect
            label={`${label}思考级别`}
            value={value.reasoning}
            disabled={disabled}
            options={[
              ...(!valid ? [{ value: value.reasoning, label: `${value.reasoning}（不可用）` }] : []),
              ...selected.presets.map((reasoning) => ({
                value: reasoning,
                label: modelReasoningLabel(selected.model, reasoning),
              })),
            ]}
            onChange={(reasoning) => onChange({ ...value, reasoning })}
          />
        </div>
      )}
      {value && !valid && (
        <p className="run-error" role="status">
          {label}或思考级别不可用，运行时会报告错误，不会自动切换。
        </p>
      )}
    </>
  );
}

function ThresholdInput({
  name,
  value,
  disabled,
  onChange,
}: {
  name: keyof typeof memorySettingLimits;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const limits = memorySettingLimits[name];
  const label = {
    minIdleHours: "最少空闲小时",
    maxAgeDays: "历史窗口天数",
    maxRolloutsPerBatch: "每批最多会话数",
  }[name];
  const commit = () => {
    const next = draft.trim() ? Number(draft) : Number.NaN;
    if (Number.isInteger(next) && next >= limits.min && next <= limits.max) {
      if (next !== value) onChange(next);
    } else setDraft(String(value));
  };
  return (
    <label className="settings-row">
      <span className="settings-row-copy">
        <strong>{label}</strong>
      </span>
      <input
        aria-label={label}
        className="memory-threshold"
        type="number"
        min={limits.min}
        max={limits.max}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

export function MemorySettings({ onNavigate }: { onNavigate?: () => void }) {
  const sessionId = useStore((state) => state.selected) ?? null;
  const providers = useStore((state) => state.settings?.providers) ?? [];
  const [settings, setSettings] = useState<MemorySettingsData>();
  const [status, setStatus] = useState<MemoryStatus>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [file, setFile] = useState<{ path: string; content: string; scope: "user" | "project" | "long" }>();
  const locked = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = unwrap(await window.zpi.getMemoryStatus(sessionId));
        if (active) setStatus(next);
      } catch (cause) {
        if (active) setError(userErrorMessage(cause));
      } finally {
        polling = false;
      }
    };
    void window.zpi
      .getMemorySettings()
      .then(unwrap)
      .then((next) => {
        if (active) setSettings(next);
      })
      .catch((cause) => {
        if (active) setError(userErrorMessage(cause));
      });
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);
  const act = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      const next = unwrap(await window.zpi.getMemoryStatus(sessionId));
      if (alive.current) setStatus(next);
    } catch (cause) {
      if (alive.current) setError(userErrorMessage(cause));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const save = (change: Partial<MemorySettingsData>) => {
    if (!settings) return;
    void act(async () => {
      const next = unwrap(await window.zpi.saveMemorySettings({ ...settings, ...change }));
      if (alive.current) {
        setSettings(next);
        setNotice("已保存。");
      }
    });
  };
  const open = (scope: "user" | "project" | "long", action: "view" | "edit") => {
    void act(async () => {
      const next = unwrap(await window.zpi.openMemoryFile(sessionId, scope, action));
      if (!alive.current || action !== "view") return;
      if (!next.exists) {
        setNotice(scope === "long" ? "长期记忆尚未生成。" : "记忆文件尚未创建，可点击编辑添加内容。");
      } else if (scope === "long") {
        setNotice("已用默认程序打开长期记忆。");
      } else setFile({ ...next, scope });
    });
  };
  const fileStatus = status?.shortFiles.find((entry) => entry.scope === file?.scope);
  const statusLabel =
    status &&
    {
      disabled: "未开启",
      paused: "已暂停生成",
      idle: "尚未运行",
      "no-candidates": "无候选会话",
      "waiting-idle": "等待会话空闲",
      unchanged: "没有新增内容",
      running: "正在处理…",
      success: "已更新",
      failed: "更新失败",
      cancelled: "已取消",
    }[status.long.status];
  return (
    <section className="memory-settings" aria-label="记忆设置">
      {!settings ? (
        <p role="status">正在读取设置…</p>
      ) : (
        <>
          <h2 className="memory-heading">短记忆</h2>
          <div className="settings-group">
            <div className="settings-row">
              <span className="settings-label">
                <strong>启用短记忆</strong>
                <SettingsHelp
                  label="短记忆"
                  text="与长期记忆互斥，开启时自动关闭长期记忆。保存明确偏好与可复用约束，由主 Agent 维护用户和当前项目的 MEMORY.md。每个文件最多 20 条、正文共 2,000 个 Unicode 字符；异常文件不加载。开关在新对话首次发送时生效，已有对话保留原配置；文件内容在安全轮次刷新。关闭保留数据，快速对话不加载。"
                />
              </span>
              <span className="settings-switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="短记忆"
                  aria-checked={settings.short}
                  checked={settings.short}
                  disabled={busy}
                  onChange={(event) =>
                    save(event.target.checked ? { short: true, long: false } : { short: false })
                  }
                />
                <span aria-hidden="true" />
              </span>
            </div>
            {status?.shortFiles.map((entry) => (
              <div className="memory-file" key={entry.scope}>
                <div className="settings-row">
                  <strong>{entry.scope === "user" ? "用户记忆" : "当前项目记忆"}</strong>
                  <div className="memory-actions">
                    <button
                      type="button"
                      className="settings-action-button"
                      disabled={busy}
                      onClick={() => open(entry.scope, "view")}
                    >
                      查看
                    </button>
                    <button
                      type="button"
                      className="settings-action-button"
                      disabled={busy}
                      onClick={() => open(entry.scope, "edit")}
                    >
                      编辑
                    </button>
                  </div>
                </div>
                {!!entry.diagnostics.length && (
                  <div className="memory-file-warning" role="status">
                    <span>文件异常，未自动加载</span>
                    <SettingsHelp
                      label={`${entry.scope === "user" ? "用户" : "项目"}记忆异常`}
                      text={entry.diagnostics.join("\n")}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
          <h2 className="memory-heading">长期记忆</h2>
          <div className="settings-group">
            <div className="settings-row">
              <span className="settings-label">
                <strong>启用长期记忆</strong>
                <SettingsHelp
                  label="长期记忆"
                  text="从历史会话提取可复用经验，仅自动加载简短摘要，详情按需读取。与短记忆互斥，开启时自动关闭短记忆。新对话首次发送时保存开关配置；关闭立即取消后台任务并保留数据，已有对话仍按原配置读取。快速对话不加载或生成记忆。"
                />
              </span>
              <span className="settings-switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="长期记忆"
                  aria-checked={settings.long}
                  checked={settings.long}
                  disabled={busy}
                  onChange={(event) =>
                    save(event.target.checked ? { long: true, short: false } : { long: false })
                  }
                />
                <span aria-hidden="true" />
              </span>
            </div>
            <div className="settings-row">
              <span className="settings-label">
                <strong>自动生成</strong>
                <SettingsHelp
                  label="自动生成"
                  text="普通根会话启动时异步检查已空闲的历史。暂停会取消后台任务，已有记忆仍可使用；关闭和暂停都不会删除数据。立即检查同样遵守空闲门槛及批量限制。"
                />
              </span>
              <span className="settings-switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="自动生成长期记忆"
                  aria-checked={settings.generate}
                  checked={settings.generate}
                  disabled={busy}
                  onChange={(event) => save({ generate: event.target.checked })}
                />
                <span aria-hidden="true" />
              </span>
            </div>
            <div className="settings-row">
              <span className="settings-label">
                <strong>模型策略</strong>
                <SettingsHelp
                  label="记忆模型策略"
                  text="每批启动时冻结提供商、模型和思考级别，两个阶段默认共用。前台切换模型不影响已启动的批次；无效配置会报错，不自动切换。后台用量单独记录，提供商额度未知时仍受每批上限约束。"
                />
              </span>
              <SettingsSelect
                label="记忆模型策略"
                value={settings.modelMode}
                disabled={busy}
                options={[
                  { value: "follow", label: "跟随触发会话" },
                  { value: "manual", label: "手动指定" },
                ]}
                onChange={(modelMode) => save({ modelMode })}
              />
            </div>
            {settings.modelMode === "manual" && (
              <MemoryModelSelection
                label="默认记忆模型"
                providers={providers}
                value={settings.selection}
                disabled={busy}
                onChange={(selection) => save({ selection })}
              />
            )}
          </div>
          <details className="memory-advanced">
            <summary>高级设置</summary>
            <div className="settings-group">
              <MemoryModelSelection
                label="提取阶段模型"
                providers={providers}
                value={settings.extractSelection}
                disabled={busy}
                optional
                onChange={(extractSelection) => save({ extractSelection })}
              />
              <MemoryModelSelection
                label="整合阶段模型"
                providers={providers}
                value={settings.consolidateSelection}
                disabled={busy}
                optional
                onChange={(consolidateSelection) => save({ consolidateSelection })}
              />
              {(Object.keys(memorySettingLimits) as (keyof typeof memorySettingLimits)[]).map((name) => (
                <ThresholdInput
                  key={`${name}:${settings[name]}`}
                  name={name}
                  value={settings[name]}
                  disabled={busy}
                  onChange={(value) => save({ [name]: value })}
                />
              ))}
            </div>
          </details>
          <div className="memory-actions">
            <button
              type="button"
              className="settings-action-button"
              disabled={busy}
              onClick={() => open("long", "view")}
            >
              查看长期记忆
            </button>
            <button
              type="button"
              className="settings-action-button"
              disabled={busy || !settings.long || !settings.generate || status?.long.running}
              onClick={() =>
                void act(async () => {
                  const next = unwrap(await window.zpi.checkMemoryNow(sessionId));
                  if (alive.current) setStatus(next);
                })
              }
            >
              立即检查更新
            </button>
            <Dialog.Root
              open={confirmClear}
              onOpenChange={(open) => {
                if (!busy) {
                  setConfirmClear(open);
                  setError("");
                }
              }}
            >
              <Dialog.Trigger asChild>
                <button type="button" className="settings-action-button" disabled={busy}>
                  清空长期记忆…
                </button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="modal-backdrop memory-dialog-backdrop" />
                <Dialog.Content
                  className="modal memory-clear-dialog"
                  onEscapeKeyDown={(event) => {
                    event.stopPropagation();
                    if (busy) event.preventDefault();
                  }}
                  onPointerDownOutside={(event) => {
                    if (busy) event.preventDefault();
                  }}
                >
                  <Dialog.Title>清空长期记忆？</Dialog.Title>
                  <Dialog.Description>
                    将取消后台任务并删除长期记忆，无法撤销。原始会话及短记忆保留。
                  </Dialog.Description>
                  {error && (
                    <p className="run-error" role="alert">
                      {error}
                    </p>
                  )}
                  <div className="modal-actions">
                    <Dialog.Close className="secondary" disabled={busy}>
                      取消
                    </Dialog.Close>
                    <button
                      type="button"
                      className="danger-button"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const next = unwrap(await window.zpi.clearLongMemory());
                          if (alive.current) {
                            setStatus(next);
                            setConfirmClear(false);
                            setNotice("长期记忆已清空。");
                          }
                        })
                      }
                    >
                      {busy ? "清空中…" : "清空"}
                    </button>
                  </div>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </div>
          {status && (
            <div className="memory-status" role="status">
              <span className={status.long.status === "failed" ? "run-error" : undefined}>{statusLabel}</span>
              <SettingsHelp
                label="长期记忆状态"
                text={`${status.long.message}\n最近检查：${status.long.lastRun ? new Date(status.long.lastRun).toLocaleString() : "尚未运行"}\n后台用量：${status.long.tokens.toLocaleString()} tokens · 费用：${status.long.cost === null ? "未知" : `$${status.long.cost.toFixed(4)}`}`}
              />
              {status.long.tokens > 0 && <small>后台用量 {status.long.tokens.toLocaleString()} tokens</small>}
            </div>
          )}
          {(
            [
              ["本轮读取的记忆", status?.usedSources],
              ["长期库来源", status?.long.sources],
            ] as const
          ).map(
            ([label, sources]) =>
              !!sources?.length && (
                <details className="memory-source-section" key={label}>
                  <summary>
                    {label}（{sources.length}）
                  </summary>
                  <ul className="memory-sources">
                    {sources.map((source) => (
                      <li key={source.sessionId}>
                        <a
                          href={`#${source.sessionId}`}
                          onClick={(event) => {
                            event.preventDefault();
                            void act(async () => {
                              await selectSession(source.sessionId);
                              onNavigate?.();
                            });
                          }}
                        >
                          {source.title || source.sessionId}
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
              ),
          )}
        </>
      )}
      {(busy || notice) && (
        <p className="memory-notice" role="status">
          {busy ? "处理中…" : notice}
        </p>
      )}
      {error && (
        <p className="run-error" role="alert">
          {error}
        </p>
      )}
      <Dialog.Root
        open={!!file}
        onOpenChange={(value) => {
          if (!value) setFile(undefined);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-backdrop memory-dialog-backdrop" />
          <Dialog.Content
            className="memory-preview"
            aria-describedby={undefined}
            onEscapeKeyDown={(event) => event.stopPropagation()}
          >
            <header>
              <Dialog.Title>记忆文件</Dialog.Title>
              <Dialog.Close aria-label="关闭记忆文件">
                <X size={16} />
              </Dialog.Close>
            </header>
            <code>{file?.path}</code>
            {fileStatus && (
              <>
                <p className="settings-hint">
                  {fileStatus.count} / 20 条 · {fileStatus.characters.toLocaleString()} / 2,000 字符
                </p>
                {fileStatus.diagnostics.map((message) => (
                  <p className="run-error" key={message}>
                    {message}
                  </p>
                ))}
              </>
            )}
            <pre>{file?.content || "文件为空或尚未创建。"}</pre>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
