import * as Dialog from "@radix-ui/react-dialog";
import { Check, ChevronDown, CircleHelp, LockKeyhole, X } from "lucide-react";
import { useRef, useState } from "react";
import type { ModelSettings } from "../shared/bridge.ts";
import { modelDefaults, reasoningLabels, reasoningPresets, toThinking } from "../shared/config.ts";
import { SettingsSelect } from "./SettingsSelect.tsx";

export interface ModelDraft extends ModelSettings {
  thinkingText: Record<string, string>;
  samplingText: string;
}
export const draftModel = (model: ModelSettings): ModelDraft => ({
  ...model,
  thinkingText: Object.fromEntries(
    reasoningPresets.map((preset) => {
      const value = model.thinkingLevelMap?.[toThinking(preset)];
      return [preset, value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value)];
    }),
  ),
  samplingText: model.samplingParams ? JSON.stringify(model.samplingParams, null, 2) : "",
});
export function serializeModel({ thinkingText, samplingText, ...model }: ModelDraft): ModelSettings {
  const result: ModelSettings = {
    id: model.id,
    ...Object.fromEntries(Object.entries(model).filter(([, value]) => value !== undefined)),
  };
  result.thinkingLevelMap = Object.assign(
    Object.fromEntries(
      Object.entries(model.thinkingLevelMap ?? {}).filter(
        ([level]) => !["off", "low", "high", "max"].includes(level),
      ),
    ),
    Object.fromEntries(
      reasoningPresets.flatMap((preset) => {
        const text = thinkingText[preset]?.trim();
        return text
          ? [
              [
                toThinking(preset),
                text === "null" || text.startsWith("{") || text.startsWith('"') ? JSON.parse(text) : text,
              ],
            ]
          : [];
      }),
    ),
  );
  if (samplingText.trim()) result.samplingParams = JSON.parse(samplingText);
  else delete result.samplingParams;
  return result;
}
function Help({ text }: { text: string }) {
  return (
    <span title={text} className="model-help">
      <CircleHelp size={14} />
    </span>
  );
}
export function ModelConfigDialog({
  initial,
  recommended,
  onClose,
  onSave,
}: {
  initial: ModelDraft;
  recommended?: ModelSettings;
  onClose: () => void;
  onSave: (value: ModelDraft) => Promise<void>;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [model, setModel] = useState(initial),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const edit = (field: keyof ModelDraft, value: unknown) =>
    setModel((current) => ({
      ...current,
      [field]: value,
      ...(field !== "id" && field !== "name" ? { useRecommendedConfig: false } : {}),
    }));
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      serializeModel(model);
      await onSave(model);
      onClose();
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop model-config-backdrop" />
        <Dialog.Content
          className="model-config-dialog"
          ref={content}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            content.current
              ?.querySelector<HTMLInputElement>(
                initial.id ? 'input[aria-label="上下文容量"]' : 'input[aria-label="Model ID"]',
              )
              ?.focus();
          }}
          onEscapeKeyDown={(event) => {
            event.stopPropagation();
            if (saving) event.preventDefault();
          }}
        >
          <header className="model-config-heading">
            <Dialog.Title>{initial.id ? "编辑模型配置" : "新增模型"}</Dialog.Title>
            <Dialog.Description className="sr-only">
              设置模型 ID、上下文、输入类型及推理参数。
            </Dialog.Description>
            <Dialog.Close className="model-config-close" aria-label="关闭模型配置" disabled={saving}>
              <X size={16} />
            </Dialog.Close>
            <label className="model-smart-switch">
              <strong>智能配置</strong>
              <Help text="采用接口或 Pi 目录的推荐配置；修改参数后转为自定义配置。" />
              <span className="settings-switch">
                <input
                  type="checkbox"
                  aria-label="智能配置"
                  checked={model.useRecommendedConfig ?? false}
                  disabled={!recommended || saving}
                  onChange={(event) =>
                    setModel(
                      event.target.checked && recommended
                        ? draftModel({ ...recommended, enabled: model.enabled, useRecommendedConfig: true })
                        : { ...model, useRecommendedConfig: false },
                    )
                  }
                />
                <span aria-hidden="true" />
              </span>
            </label>
          </header>
          <div className="model-config-body">
            <fieldset disabled={saving}>
              <label>
                模型 ID
                <input
                  aria-label="Model ID"
                  value={model.id}
                  onChange={(event) => edit("id", event.target.value)}
                />
              </label>
              <label>
                显示名称
                <input
                  aria-label="模型显示名称"
                  value={model.name ?? ""}
                  onChange={(event) => edit("name", event.target.value)}
                />
              </label>
              <label>
                <span>
                  上下文窗口 <Help text="输入和输出 token 的总容量。" />
                </span>
                <input
                  aria-label="上下文容量"
                  type="number"
                  value={model.contextWindow ?? ""}
                  placeholder={String(modelDefaults.contextWindow)}
                  onChange={(event) =>
                    edit("contextWindow", event.target.value ? Number(event.target.value) : undefined)
                  }
                />
              </label>
              <label>
                <span>
                  最大输出 Token <Help text="模型单次响应的输出上限。" />
                </span>
                <input
                  aria-label="输出上限"
                  type="number"
                  value={model.maxTokens ?? ""}
                  placeholder={String(modelDefaults.maxTokens)}
                  onChange={(event) =>
                    edit("maxTokens", event.target.value ? Number(event.target.value) : undefined)
                  }
                />
              </label>
              <details className="model-config-advanced">
                <summary>
                  <ChevronDown size={16} />
                  高级配置
                </summary>
                <div className="model-option-group">
                  <span>
                    输入类型 <Help text="根据服务端声明或 Pi 目录设置；文本始终启用。" />
                  </span>
                  <div className="model-option-chips">
                    {(["text", "image", "video", "pdf"] as const).map((type) => {
                      const selected = type === "text" || Boolean(model.input?.includes(type));
                      return (
                        <button
                          key={type}
                          type="button"
                          aria-pressed={selected}
                          disabled={type === "text"}
                          className="model-option-chip"
                          onClick={() =>
                            edit(
                              "input",
                              selected
                                ? (model.input ?? ["text"]).filter((item) => item !== type)
                                : [...(model.input ?? ["text"]), type],
                            )
                          }
                        >
                          <span className="model-option-check">{selected && <Check size={13} />}</span>
                          {{ text: "文本", image: "图片", video: "视频", pdf: "PDF" }[type]}
                          {type === "text" && <LockKeyhole size={13} />}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="model-option-group">
                  <span>
                    模型能力 <Help text="仅影响发送参数，不增加工具或附件类型。" />
                  </span>
                  <div className="model-option-chips">
                    <button
                      type="button"
                      className="model-option-chip"
                      aria-pressed={model.reasoning ?? true}
                      onClick={() => edit("reasoning", !(model.reasoning ?? true))}
                    >
                      <span className="model-option-check">
                        {(model.reasoning ?? true) && <Check size={13} />}
                      </span>
                      推理
                    </button>
                    <button
                      type="button"
                      className="model-option-chip"
                      aria-pressed={model.compat?.structuredOutput === "json_object"}
                      onClick={() =>
                        edit("compat", {
                          ...model.compat,
                          structuredOutput:
                            model.compat?.structuredOutput === "json_object" ? "prompt" : "json_object",
                        })
                      }
                    >
                      <span className="model-option-check">
                        {model.compat?.structuredOutput === "json_object" && <Check size={13} />}
                      </span>
                      结构化输出
                    </button>
                  </div>
                </div>
                <div className="model-option-group">
                  <span>推理等级（从低到高）</span>
                  <div className="model-reasoning-labels">
                    {reasoningPresets.map((preset) => (
                      <span key={preset}>{preset}</span>
                    ))}
                  </div>
                </div>
                <div className="model-option-group">
                  <span>
                    推理参数映射{" "}
                    <Help text="字符串、JSON 参数片段或 null（禁用该档位）；保持 Pi 参数语义。" />
                  </span>
                  {reasoningPresets.map((preset) => (
                    <label key={preset}>
                      {reasoningLabels[preset]}
                      <textarea
                        aria-label={`思考映射 ${reasoningLabels[preset]}`}
                        value={model.thinkingText[preset] ?? ""}
                        onChange={(event) =>
                          edit("thinkingText", { ...model.thinkingText, [preset]: event.target.value })
                        }
                        placeholder="字符串、JSON 参数片段或 null"
                      />
                    </label>
                  ))}
                </div>
                <label htmlFor="model-output-field">
                  输出上限字段
                  <SettingsSelect
                    id="model-output-field"
                    label="输出上限字段"
                    value={model.compat?.maxTokensField ?? "max_tokens"}
                    options={[
                      { value: "max_tokens", label: "max_tokens" },
                      { value: "max_completion_tokens", label: "max_completion_tokens" },
                    ]}
                    onChange={(value) => edit("compat", { ...model.compat, maxTokensField: value })}
                  />
                </label>
                <div className="model-option-chips">
                  {(
                    [
                      ["supportsDeveloperRole", "developer role"],
                      ["supportsReasoningEffort", "reasoning_effort"],
                      ["supportsUsageInStreaming", "流式 usage"],
                      ["requiresReasoningContentOnAssistantMessages", "回传 reasoning_content"],
                    ] as const
                  ).map(([field, label]) => (
                    <button
                      key={field}
                      type="button"
                      className="model-option-chip"
                      aria-pressed={
                        model.compat?.[field] ??
                        (field === "supportsUsageInStreaming" || field === "supportsReasoningEffort")
                      }
                      onClick={() =>
                        edit("compat", {
                          ...model.compat,
                          [field]: !(
                            model.compat?.[field] ??
                            (field === "supportsUsageInStreaming" || field === "supportsReasoningEffort")
                          ),
                        })
                      }
                    >
                      <span className="model-option-check">
                        {(model.compat?.[field] ??
                          (field === "supportsUsageInStreaming" || field === "supportsReasoningEffort")) && (
                          <Check size={13} />
                        )}
                      </span>
                      {label}
                    </button>
                  ))}
                </div>
                <label>
                  samplingParams（JSON）
                  <textarea
                    aria-label="samplingParams"
                    value={model.samplingText}
                    onChange={(event) => edit("samplingText", event.target.value)}
                  />
                </label>
              </details>
            </fieldset>
          </div>
          {error && (
            <div role="alert" className="model-config-error">
              {error}
            </div>
          )}
          <footer className="model-config-footer">
            <button
              className="model-reset"
              disabled={saving}
              onClick={() =>
                setModel(
                  recommended
                    ? draftModel({ ...recommended, enabled: model.enabled, useRecommendedConfig: true })
                    : initial,
                )
              }
            >
              重置表单
            </button>
            <Dialog.Close disabled={saving}>取消</Dialog.Close>
            <button className="primary" disabled={saving} onClick={() => void save()}>
              {saving ? "保存中…" : "保存"}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
