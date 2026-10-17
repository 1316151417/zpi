import { useRef, useState } from "react";
import type { CombinedSelection } from "../shared/bridge.ts";
import { defaultPreset, modelReasoningLabel } from "../shared/config.ts";
import {
  quickChatModels,
  quickChatSelection,
  quickChatSelectionIsValid,
} from "../shared/quick-chat-settings.ts";
import { defaultShortcuts, formatShortcut } from "../shared/shortcuts.ts";
import { SettingsSelect } from "./SettingsSelect.tsx";
import { unwrap, useStore } from "./store.ts";

const modelKey = (selection: { provider: string; modelId: string }) =>
  JSON.stringify([selection.provider, selection.modelId]);

export function QuickChatSettings({ onEditShortcut }: { onEditShortcut: () => void }) {
  const settings = useStore((state) => state.settings);
  const shortcuts = settings?.shortcuts ?? defaultShortcuts(window.zpi.platform);
  const models = quickChatModels(settings?.providers ?? []);
  const saved = settings?.quickChat.defaultSelection;
  const effective = settings ? quickChatSelection(settings) : null;
  const selected = models.find(
    ({ provider, model }) => provider.id === saved?.provider && model.id === saved?.modelId,
  );
  const valid = Boolean(saved && settings && quickChatSelectionIsValid(settings.providers, saved));
  const fallback = models.find(
    ({ provider, model }) => provider.id === effective?.provider && model.id === effective?.modelId,
  );
  const [opening, setOpening] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const savingRef = useRef(false);
  const open = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOpening(true);
    setError("");
    try {
      unwrap(await window.zpi.openQuickChat());
    } catch (error) {
      setError(String(error));
    } finally {
      inFlight.current = false;
      setOpening(false);
    }
  };
  const save = async (defaultSelection: CombinedSelection | null) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const next = unwrap(await window.zpi.saveQuickChatSettings({ defaultSelection }));
      useStore.setState({ settings: next });
      setNotice("已保存，将从下一次发送起生效。");
    } catch (error) {
      setError(`默认模型保存失败，原设置未更改。${error instanceof Error ? error.message : String(error)}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <section className="quick-chat-settings" aria-label="快速对话设置">
      <p className="settings-intro">临时对话，不保存到任务列表</p>
      <p className="settings-hint">
        可用 read、bash 及已启用的联网工具；只读要求依赖提示词，bash 仍可读写本机文件。
      </p>
      <div className="settings-group">
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>全局快捷键</strong>
            <small>
              {formatShortcut(shortcuts.bindings["quick-chat"], window.zpi.platform)}
              {!shortcuts.enabled && "（快捷键已停用）"}
            </small>
          </span>
          <button type="button" className="settings-action-button" disabled={saving} onClick={onEditShortcut}>
            修改快捷键
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>默认模型</strong>
            <small>仅用于快速对话，与任务的模型选择独立。</small>
          </span>
          <SettingsSelect
            label="快速对话默认模型"
            value={saved ? (valid ? modelKey(saved) : "unavailable") : "auto"}
            disabled={saving || !models.length}
            options={[
              { value: "auto", label: "自动选择首个可用模型" },
              ...(saved && !valid ? [{ value: "unavailable", label: "原默认模型或思考级别已不可用" }] : []),
              ...models.map(({ provider, model }) => ({
                value: modelKey({ provider: provider.id, modelId: model.id }),
                label: `${provider.name} · ${model.name || model.id}`,
              })),
            ]}
            onChange={(value) => {
              if (value === "auto") void save(null);
              else {
                const next = models.find(
                  ({ provider, model }) => modelKey({ provider: provider.id, modelId: model.id }) === value,
                );
                if (next)
                  void save({
                    provider: next.provider.id,
                    modelId: next.model.id,
                    reasoning: defaultPreset(next.model),
                  });
              }
            }}
          />
        </div>
        {valid && saved && selected && (
          <div className="settings-row">
            <span className="settings-row-copy">
              <strong>思考级别</strong>
            </span>
            <SettingsSelect
              label="快速对话思考级别"
              value={saved.reasoning}
              disabled={saving || selected.presets.length < 2}
              options={[
                ...(!selected.presets.includes(saved.reasoning) ? [saved.reasoning] : []),
                ...selected.presets,
              ].map((reasoning) => ({
                value: reasoning,
                label: modelReasoningLabel(selected.model, reasoning),
              }))}
              onChange={(reasoning) => void save({ ...saved, reasoning })}
            />
          </div>
        )}
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>快速对话</strong>
          </span>
          <button type="button" className="primary" disabled={opening} onClick={() => void open()}>
            {opening ? "打开中…" : "打开快速对话"}
          </button>
        </div>
      </div>
      <p className="settings-hint">
        更改自动保存，从下一次发送起生效，不会中断当前回复。
        未指定默认模型，或默认模型、思考级别不可用时，按提供商和模型顺序使用首个可用模型及其默认思考级别。
      </p>
      {!effective ? (
        <p role="status" className="settings-hint">
          暂无可用模型，请先在「模型」设置中添加并启用模型。
        </p>
      ) : (
        (!saved || !valid) && (
          <p role="status" className="settings-hint">
            {saved ? "原默认配置已不可用，" : ""}当前自动使用：{fallback?.provider.name} ·{" "}
            {fallback?.model.name || effective.modelId}（
            {modelReasoningLabel(fallback?.model, effective.reasoning)}）
          </p>
        )
      )}
      {(saving || notice) && <p role="status">{saving ? "保存中…" : notice}</p>}
      {error && (
        <p role="alert" className="run-error">
          {error}
        </p>
      )}
    </section>
  );
}
