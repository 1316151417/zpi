import * as Dialog from "@radix-ui/react-dialog";
import { Check, CircleHelp, LoaderCircle, LockKeyhole, X } from "lucide-react";
import { useRef, useState } from "react";
import type { ReasoningConfig } from "zpi-ai";
import { editableReasoningConfig, validateReasoningConfig } from "zpi-ai";
import type { ModelSettings } from "../shared/bridge.ts";
import { modelDefaults, reasoningModel, toPreset } from "../shared/config.ts";
import { ModelConfigAdvanced } from "./ModelConfigAdvanced.tsx";
import { ReasoningLevelEditor } from "./ReasoningLevelEditor.tsx";
import { SettingsSelect } from "./SettingsSelect.tsx";

export interface ModelDraft extends ModelSettings {
  reasoningConfig: ReasoningConfig;
  samplingText: string;
}
export const draftModel = (model: ModelSettings): ModelDraft => ({
  ...model,
  reasoningConfig: editableReasoningConfig(reasoningModel(model)),
  ...(model.defaultThinkingLevel
    ? { defaultThinkingLevel: toPreset(model.defaultThinkingLevel, model) }
    : {}),
  samplingText: model.samplingParams ? JSON.stringify(model.samplingParams, null, 2) : "",
});
export function serializeModel({ samplingText, ...model }: ModelDraft): ModelSettings {
  validateReasoningConfig(model.reasoningConfig);
  const result: ModelSettings = {
    id: model.id,
    ...Object.fromEntries(Object.entries(model).filter(([, value]) => value !== undefined)),
  };
  delete result.thinkingLevelMap;
  if (result.reasoning === false) delete result.defaultThinkingLevel;
  else if (result.defaultThinkingLevel && !model.reasoningConfig.levels.includes(result.defaultThinkingLevel))
    result.defaultThinkingLevel = model.reasoningConfig.levels.at(-1);
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
  chatgpt = false,
  onClose,
  onSave,
}: {
  initial: ModelDraft;
  recommended?: ModelSettings;
  chatgpt?: boolean;
  onClose: () => void;
  onSave: (value: ModelDraft) => Promise<void>;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [model, setModel] = useState(initial),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [invalidMapping, setInvalidMapping] = useState(false),
    [validationAttempt, setValidationAttempt] = useState(0);
  const edit = (field: keyof ModelDraft, value: unknown) =>
    setModel((current) => ({
      ...current,
      [field]: value,
      ...(field !== "id" && field !== "name" ? { useRecommendedConfig: false } : {}),
    }));
  const save = async () => {
    setSaving(true);
    setError("");
    setInvalidMapping(false);
    try {
      serializeModel(model);
      await onSave(model);
      onClose();
    } catch (error) {
      setError(String(error));
      try {
        validateReasoningConfig(model.reasoningConfig);
      } catch {
        setInvalidMapping(true);
      }
    } finally {
      setSaving(false);
      setValidationAttempt((value) => value + 1);
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
            if (
              event.target instanceof Element &&
              event.target.matches("[data-model-reasoning-level-input]")
            ) {
              event.preventDefault();
              return;
            }
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
              <X size={12} />
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
              {!initial.id && (
                <div className="model-config-identity">
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
                </div>
              )}
              <label>
                <span>
                  上下文窗口 <Help text="输入和输出 token 的总容量。" />
                </span>
                <input
                  aria-label="上下文容量"
                  data-inherited={
                    model.useRecommendedConfig && model.contextWindow === recommended?.contextWindow
                  }
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
                  最大输出 Token{" "}
                  <Help
                    text={
                      chatgpt
                        ? "用于本地上下文预算；ChatGPT 套餐响应长度由服务端控制。"
                        : "模型单次响应的输出上限。"
                    }
                  />
                </span>
                <input
                  aria-label="输出上限"
                  data-inherited={model.useRecommendedConfig && model.maxTokens === recommended?.maxTokens}
                  type="number"
                  value={model.maxTokens ?? ""}
                  placeholder={String(modelDefaults.maxTokens)}
                  onChange={(event) =>
                    edit("maxTokens", event.target.value ? Number(event.target.value) : undefined)
                  }
                />
              </label>
              <ModelConfigAdvanced invalidMapping={invalidMapping} validationAttempt={validationAttempt}>
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
                          <span className="model-option-check">{selected && <Check size={12} />}</span>
                          {{ text: "文本", image: "图片", video: "视频", pdf: "PDF" }[type]}
                          {type === "text" && <LockKeyhole size={14} />}
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
                        {(model.reasoning ?? true) && <Check size={12} />}
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
                        {model.compat?.structuredOutput === "json_object" && <Check size={12} />}
                      </span>
                      结构化输出
                    </button>
                  </div>
                </div>
                {(model.reasoning ?? true) && (
                  <>
                    <div className="model-option-group">
                      <span>
                        推理等级（从低到高）
                        <Help text="点击编辑等级名称，拖动或按 Alt + 左右方向键排序；最后一级为自定义模型的默认值。" />
                      </span>
                      <ReasoningLevelEditor
                        values={model.reasoningConfig.levels}
                        overridden={model.useRecommendedConfig === false}
                        addLabel="添加推理等级"
                        deleteLabel="删除推理等级"
                        onChange={(levels) =>
                          edit("reasoningConfig", { ...model.reasoningConfig, levels: [...levels] })
                        }
                      />
                    </div>
                    <label>
                      <span>
                        推理参数映射
                        <Help text="使用 reasoningLevel 变量编写 CEL 表达式，结果为请求参数 JSON 对象。每个等级都必须能得到有效映射。" />
                      </span>
                      <textarea
                        aria-label="推理参数映射"
                        spellCheck={false}
                        value={model.reasoningConfig.map}
                        onChange={(event) =>
                          edit("reasoningConfig", { ...model.reasoningConfig, map: event.target.value })
                        }
                      />
                    </label>
                  </>
                )}
                <details className="model-transport-options">
                  <summary>请求参数</summary>
                  {!chatgpt && (
                    <>
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
                                  (field === "supportsUsageInStreaming" ||
                                    field === "supportsReasoningEffort")
                                ),
                              })
                            }
                          >
                            <span className="model-option-check">
                              {(model.compat?.[field] ??
                                (field === "supportsUsageInStreaming" ||
                                  field === "supportsReasoningEffort")) && <Check size={12} />}
                            </span>
                            {label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  <label>
                    samplingParams（JSON）
                    <textarea
                      aria-label="samplingParams"
                      value={model.samplingText}
                      onChange={(event) => edit("samplingText", event.target.value)}
                    />
                  </label>
                </details>
              </ModelConfigAdvanced>
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
              {saving && <LoaderCircle size={14} className="spin" />}保存
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
