import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Archive,
  ArrowLeft,
  Bot,
  Braces,
  Brain,
  ChevronRight,
  Globe,
  Info,
  Keyboard,
  MessageSquare,
  Monitor,
  Moon,
  Package,
  Pencil,
  Plus,
  Puzzle,
  RefreshCcw,
  Settings2,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  getProviderPreset,
  type ProviderApi,
  type ProviderPresetId,
  presetModels,
  providerApi,
  providerBaseUrl,
  providerPresets,
  usesChatGPTAuth,
} from "zpi-ai";
import { ActionHint, codePreviewThemes, defaultCodePreview, SortableList } from "zpi-ui";
import type { InterfacePreferences, ModelSettings, ProviderRecord } from "../shared/bridge.ts";
import { ArchivedTasks } from "./ArchivedTasks.tsx";
import { CapabilitySettings } from "./CapabilitySettings.tsx";
import { ChatGPTConnection } from "./ChatGPTConnection.tsx";
import { CommandSettings } from "./CommandSettings.tsx";
import { MemorySettings } from "./MemorySettings.tsx";
import { draftModel, ModelConfigDialog, type ModelDraft, serializeModel } from "./ModelConfigDialog.tsx";
import { ProviderApiFormatSelect } from "./ProviderApiFormatSelect.tsx";
import { ProviderCredentialInput } from "./ProviderCredentialInput.tsx";
import { ProviderHeadingActions } from "./ProviderHeadingActions.tsx";
import { ProviderLogo } from "./ProviderLogo.tsx";
import { QuickChatSettings } from "./QuickChatSettings.tsx";
import { ResourceSettings } from "./ResourceSettings.tsx";
import { SettingsHelp } from "./SettingsHelp.tsx";
import { SettingsSelect } from "./SettingsSelect.tsx";
import { ShortcutSettings } from "./ShortcutSettings.tsx";
import { SubagentSettings } from "./SubagentSettings.tsx";
import { refresh, useStore } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";
import { WebSearchSettings } from "./WebSearchSettings.tsx";

const sections = [
  ["general", "常规", Settings2],
  ["interface", "界面设置", Monitor],
  ["shortcuts", "快捷键", Keyboard],
  ["prompt", "系统提示词", Sparkles],
  ["tools", "工具", Wrench],
  ["skills", "技能", Puzzle],
  ["commands", "命令", Terminal],
  ["models", "模型", Braces],
  ["capabilities", "扩展能力", Package],
  ["webSearch", "联网搜索", Globe],
  ["subagents", "子智能体", Bot],
  ["memory", "记忆", Brain],
  ["quickChat", "快速对话", MessageSquare],
  ["archived", "已归档任务", Archive],
] as const;
type SettingsTab = (typeof sections)[number][0];
const pageHelp: Partial<Record<SettingsTab, string>> = {
  interface: "主题和界面字号影响本机显示，代码预览可单独配置。",
  models: "配置提供商和模型后，可在聊天中选择使用。模型和提供商可分别启停。",
  capabilities: "开关在新对话首次发送时生效，已有对话保留原配置。",
  commands: "在输入框键入 / 调用命令。可配置个人或项目命令，也可导入外部 Agent 的命令。",
  quickChat:
    "临时对话，不保存到任务列表。可用 read、bash 及已启用的联网工具；只读要求依赖提示词，bash 仍可读写本机文件。",
};

import {
  defaultPreferences,
  mergeDiscoveredModels,
  modelDefaults,
  uiFontSizeLimits,
} from "../shared/config.ts";

const recommendedModels = (provider?: ProviderRecord) =>
  new Map<string, ModelSettings>([
    ...presetModels(provider?.preset ?? "", provider?.api ?? "openai-completions").map(
      (model) => [model.id, model] as const,
    ),
    ...(provider?.models ?? [])
      .filter((model) => model.useRecommendedConfig && model.metadataSource)
      .map((model) => [model.id, model] as const),
  ]);
const contextLabel = (value: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const newModel = (api: ProviderApi) => ({
  id: "",
  ...modelDefaults,
  ...(api === "anthropic-messages" ? { compat: { supportsEagerToolInputStreaming: true } } : {}),
  input: ["text"] as ModelSettings["input"],
  useRecommendedConfig: false,
});
function FontSizeInput({
  value,
  onChange,
  label = "界面字号",
}: {
  value: number;
  onChange: (value: number) => void;
  label?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const commit = () => {
    const number = draft.trim() ? Number(draft) : Number.NaN;
    const next = Number.isFinite(number)
      ? Math.max(uiFontSizeLimits.min, Math.min(uiFontSizeLimits.max, Math.round(number)))
      : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <div className="settings-font-size">
      <input
        aria-label={label}
        type="number"
        inputMode="numeric"
        min={uiFontSizeLimits.min}
        max={uiFontSizeLimits.max}
        step={1}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(String(value));
          }
        }}
      />
      <span aria-hidden="true">px</span>
    </div>
  );
}
export function SettingsPage({ onClose }: { onClose: () => void }) {
  const opener = useRef(document.activeElement);
  const [commandEditing, setCommandEditing] = useState(false);
  const [commandBreadcrumb, setCommandBreadcrumb] = useState<HTMLDivElement | null>(null);
  const settings = useStore((s) => s.settings);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    back.current?.focus();
    return () => {
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
    };
  }, []);
  const [selected, setSelected] = useState<string | undefined>(settings?.providers[0]?.id);
  const original = settings?.providers.find((p) => p.id === selected);
  const [name, setName] = useState(original?.name ?? "");
  const [enabled, setEnabled] = useState(original?.enabled !== false);
  const [url, setUrl] = useState(original?.baseUrl ?? "");
  const [models, setModels] = useState<ModelDraft[]>((original?.models ?? []).map(draftModel));
  const [editing, setEditing] = useState<{ index: number; draft: ModelDraft }>();
  const [preset, setPreset] = useState<ProviderPresetId | undefined>(original?.preset);
  const chatgpt = usesChatGPTAuth(preset);
  const [api, setApi] = useState<ProviderApi>(
    original ? providerApi(original.preset, original.api ?? "openai-completions") : "anthropic-messages",
  );
  const [picker, setPicker] = useState(!settings?.providers.length);
  const [discovering, setDiscovering] = useState(false);
  const discoveryRevision = useRef(0);
  const recommended = useRef(recommendedModels(original));
  const [key, setKey] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [credentialRequest, setCredentialRequest] = useState(0);
  const [keyReady, setKeyReady] = useState(!selected);
  const [tab, setTab] = useState<SettingsTab>("interface");
  const codePreview = settings?.interface.codePreview ?? defaultCodePreview;
  const title = sections.find(([id]) => id === tab)?.[1];
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const savedDraft = useRef({ name, enabled, url, models, preset, api, key });
  const [pendingSelection, setPendingSelection] = useState<(() => void) | null>(null);
  const requestSelection = (action: () => void) => {
    if (saving) return;
    if (
      JSON.stringify({ name, enabled, url, models, preset, api, key }) !== JSON.stringify(savedDraft.current)
    )
      setPendingSelection(() => action);
    else action();
  };
  const renameInput = useRef<HTMLInputElement>(null);
  const renameStart = useRef("");
  const renameRequested = useRef(false);
  useEffect(
    () => () => {
      discoveryRevision.current++;
    },
    [],
  );
  const select = (p?: ProviderRecord) => {
    const draft = {
      name: p?.name ?? "",
      enabled: p?.enabled !== false,
      url: p?.baseUrl ?? "",
      models: (p?.models ?? []).map(draftModel),
      preset: p?.preset,
      api: p ? providerApi(p.preset, p.api ?? "openai-completions") : "anthropic-messages",
      key: "",
    };
    savedDraft.current = draft;
    discoveryRevision.current++;
    setDiscovering(false);
    setSelected(p?.id);
    setPreset(draft.preset);
    setApi(draft.api);
    setPicker(false);
    setEditing(undefined);
    recommended.current = recommendedModels(p);
    setName(draft.name);
    setEnabled(draft.enabled);
    setUrl(draft.url);
    setModels(draft.models);
    setKey(draft.key);
    setKeyVisible(false);
    setKeyReady(!p);
    setCredentialRequest((value) => value + 1);
    setError("");
    setNotice("");
    setConfirmDelete(false);
    setRenaming(false);
  };
  useEffect(() => {
    let active = true;
    setKey("");
    setKeyReady(!selected);
    if (chatgpt) {
      setKeyReady(true);
      return;
    }
    if (selected)
      void window.zpi
        .getProviderCredentials(selected)
        .then(unwrap)
        .then((value) => {
          if (active) {
            savedDraft.current = { ...savedDraft.current, key: value.apiKey };
            setKey(value.apiKey);
            setKeyReady(true);
          }
        })
        .catch((e) => {
          if (active) {
            setError(userErrorMessage(e));
            setKeyReady(false);
          }
        });
    return () => {
      active = false;
    };
  }, [selected, credentialRequest, chatgpt]);
  const loadModels = async () => {
    if (!keyReady) return;
    const revision = ++discoveryRevision.current;
    setDiscovering(true);
    setError("");
    try {
      const result = unwrap(
        await window.zpi.discoverModels({
          api,
          ...(preset ? { preset } : { baseUrl: url }),
          ...(selected ? { providerId: selected } : {}),
          ...(!chatgpt ? { apiKey: key } : {}),
        }),
      );
      if (revision !== discoveryRevision.current) return;
      recommended.current = new Map(result.models.map((model) => [model.id, model]));
      setModels((current) => mergeDiscoveredModels(current, result.models.map(draftModel)));
      setNotice(result.warning ?? `已获取 ${result.models.length} 个模型。`);
    } catch (error) {
      if (revision === discoveryRevision.current) setError(userErrorMessage(error));
    } finally {
      if (revision === discoveryRevision.current) setDiscovering(false);
    }
  };
  const selectPreset = (id: ProviderPresetId) => {
    const descriptor = getProviderPreset(id);
    if (!descriptor) return;
    select();
    setPreset(id);
    setName(descriptor.name);
    const nextApi = providerApi(id);
    setApi(nextApi);
    setUrl(providerBaseUrl(id, nextApi));
    const catalog = presetModels(id, nextApi);
    recommended.current = new Map(catalog.map((model) => [model.id, model]));
    setModels(
      catalog.map((model) => draftModel({ ...model, useRecommendedConfig: true, metadataSource: "catalog" })),
    );
  };
  const changeApi = (nextApi: ProviderApi) => {
    discoveryRevision.current++;
    setDiscovering(false);
    setApi(nextApi);
    if (preset) setUrl(providerBaseUrl(preset, nextApi));
    const defaults = new Map(presetModels(preset ?? "", nextApi).map((model) => [model.id, model]));
    recommended.current = defaults;
    setModels((current) =>
      current.map((model) => {
        const known = defaults.get(model.id);
        const next = {
          ...model,
          ...(known && model.useRecommendedConfig !== false ? known : {}),
          compat: known?.compat ?? newModel(nextApi).compat,
        };
        delete (next as ModelSettings).reasoningConfig;
        if (nextApi === "anthropic-messages" && model.useRecommendedConfig !== false)
          delete next.samplingParams;
        delete next.defaultThinkingLevel;
        if (known?.defaultThinkingLevel) next.defaultThinkingLevel = known.defaultThinkingLevel;
        if (known?.thinkingLevelMap) next.thinkingLevelMap = known.thinkingLevelMap;
        else delete next.thinkingLevelMap;
        return draftModel(next);
      }),
    );
    setEditing(undefined);
    setError("");
    setNotice("已切换协议并更新推理参数映射，保存后生效。");
  };
  const updateAppearance = (input: Partial<InterfacePreferences>) => {
    void window.zpi
      .updatePreferences(input)
      .then(unwrap)
      .then((value) => useStore.setState({ settings: value }))
      .catch((error) => setError(userErrorMessage(error)));
  };
  const save = async (nextModels = models, nextEnabled = enabled, nextName = name) => {
    if (!keyReady) return false;
    setSaving(true);
    setError("");
    try {
      let discoveryNotice = "";
      if (!selected && preset && !chatgpt && key.trim()) {
        const result = unwrap(
          await window.zpi.discoverModels({
            preset,
            api,
            apiKey: key,
          }),
        );
        nextModels = mergeDiscoveredModels(nextModels, result.models.map(draftModel));
        recommended.current = new Map(result.models.map((model) => [model.id, model]));
        discoveryNotice = result.warning ?? "";
      }
      const value = unwrap(
        await window.zpi.saveProvider({
          ...(selected ? { id: selected } : {}),
          ...(preset ? { preset } : {}),
          api,
          name: nextName,
          enabled: nextEnabled,
          baseUrl: url,
          models: nextModels.map(serializeModel),
          ...(!chatgpt ? { apiKey: key } : {}),
        }),
      );
      useStore.setState({ settings: value });
      const saved = value.providers.find((provider) => provider.id === selected) ?? value.providers.at(-1);
      select(saved);
      await refresh();
      setNotice(discoveryNotice || "提供商已保存。");
      return true;
    } catch (error) {
      setError(userErrorMessage(error));
      return false;
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      className="settings-screen"
      aria-label="设置"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          event.keyCode !== 229 &&
          !event.defaultPrevented &&
          !(event.target instanceof Element && event.target.closest('[role="dialog"]'))
        ) {
          event.preventDefault();
          event.stopPropagation();
          requestSelection(onClose);
        }
      }}
    >
      <aside className="settings-sidebar">
        <div className="settings-sidebar-drag-space" aria-hidden="true" />
        <ActionHint appearance="control" label="返回工作区" side="right">
          <button
            ref={back}
            className="settings-back"
            aria-label="关闭设置"
            disabled={saving}
            onClick={() => requestSelection(onClose)}
          >
            <ArrowLeft size={16} />
            <span>返回任务</span>
          </button>
        </ActionHint>
        <nav className="settings-tabs" aria-label="设置分类">
          {sections.map(([id, label, Icon]) => (
            <ActionHint appearance="control" label={label} side="right" key={id}>
              <button aria-label={label} aria-pressed={tab === id} onClick={() => setTab(id)}>
                <Icon size={16} />
                <span>{label}</span>
              </button>
            </ActionHint>
          ))}
        </nav>
      </aside>
      <div className="settings-main">
        <div
          className="settings-titlebar"
          ref={setCommandBreadcrumb}
          aria-hidden={tab !== "commands" || !commandEditing}
        />
        <div className="settings-scroll">
          <div className={`settings-content ${tab === "models" ? "model-settings-content" : ""}`}>
            {!["archived", "shortcuts", "webSearch", "subagents"].includes(tab) &&
              !(tab === "commands" && commandEditing) && (
                <div className="settings-page-heading">
                  <div className="settings-heading-title">
                    <h1>{tab === "models" ? "模型设置" : tab === "interface" ? "外观" : title}</h1>
                    {pageHelp[tab] && <SettingsHelp label={title ?? "设置"} text={pageHelp[tab] ?? ""} />}
                  </div>
                </div>
              )}
            <div className="settings-page">
              {tab === "commands" ? (
                <CommandSettings
                  breadcrumbContainer={commandBreadcrumb}
                  onEditingChange={setCommandEditing}
                />
              ) : tab === "archived" ? (
                <ArchivedTasks />
              ) : tab === "shortcuts" ? (
                <ShortcutSettings />
              ) : tab === "general" ? (
                <div className="general-settings">
                  <div className="settings-group">
                    {(
                      [
                        ["notificationEnabled", "任务通知", "任务完成、失败或需要确认时发送桌面通知。"],
                        ["notificationSoundEnabled", "通知声音", "通知开启后，可单独关闭任务通知提示音。"],
                      ] as const
                    ).map(([field, label, description]) => (
                      <div className="settings-row" key={field}>
                        <span className="settings-label">
                          <strong>{label}</strong>
                          <SettingsHelp label={label} text={description} />
                        </span>
                        <span className="settings-switch task-notification-switch">
                          <input
                            type="checkbox"
                            role="switch"
                            aria-label={label}
                            aria-checked={settings?.interface[field] ?? defaultPreferences[field]}
                            checked={settings?.interface[field] ?? defaultPreferences[field]}
                            disabled={
                              field === "notificationSoundEnabled" &&
                              !(settings?.interface.notificationEnabled ?? true)
                            }
                            onChange={(event) => updateAppearance({ [field]: event.target.checked })}
                          />
                          <span aria-hidden="true" />
                        </span>
                      </div>
                    ))}
                  </div>
                  {error && <div role="alert">{error}</div>}
                </div>
              ) : tab === "webSearch" ? (
                <WebSearchSettings />
              ) : tab === "memory" ? (
                <MemorySettings onNavigate={onClose} />
              ) : tab === "subagents" ? (
                <SubagentSettings />
              ) : tab === "quickChat" ? (
                <QuickChatSettings onEditShortcut={() => setTab("shortcuts")} />
              ) : tab === "capabilities" ? (
                <CapabilitySettings />
              ) : tab === "prompt" || tab === "tools" || tab === "skills" ? (
                <ResourceSettings page={tab} />
              ) : tab === "interface" ? (
                <div className="interface-settings">
                  <h2>界面</h2>
                  <div className="settings-group">
                    <div className="settings-row">
                      <span className="settings-row-copy">
                        <strong>界面主题</strong>
                      </span>
                      <SettingsSelect
                        label="界面主题"
                        value={settings?.interface.theme ?? "system"}
                        options={[
                          { value: "system", label: "系统", icon: <Monitor size={16} /> },
                          { value: "dark", label: "深色", icon: <Moon size={16} /> },
                          { value: "light", label: "浅色", icon: <Sun size={16} /> },
                        ]}
                        onChange={(theme) => updateAppearance({ theme })}
                      />
                    </div>
                    <div className="settings-row">
                      <span className="settings-label">
                        <strong>界面字号</strong>
                        <SettingsHelp label="界面字号" text="仅调整界面文字，图标和布局尺寸保持不变。" />
                      </span>
                      <FontSizeInput
                        key={settings?.interface.fontSize ?? defaultPreferences.fontSize}
                        value={settings?.interface.fontSize ?? defaultPreferences.fontSize}
                        onChange={(fontSize) => updateAppearance({ fontSize })}
                      />
                    </div>
                  </div>
                  <h2>审查代码预览</h2>
                  <div className="settings-group">
                    {(
                      [
                        ["lightTheme", "浅色代码主题"],
                        ["darkTheme", "深色代码主题"],
                      ] as const
                    ).map(([field, label]) => (
                      <div className="settings-row" key={field}>
                        <span className="settings-row-copy">
                          <strong>{label}</strong>
                        </span>
                        <SettingsSelect
                          label={label}
                          value={codePreview[field]}
                          options={codePreviewThemes}
                          onChange={(value) =>
                            updateAppearance({ codePreview: { ...codePreview, [field]: value } })
                          }
                        />
                      </div>
                    ))}
                    <div className="settings-row">
                      <span className="settings-row-copy">
                        <strong>代码字号</strong>
                      </span>
                      <FontSizeInput
                        label="代码字号"
                        value={codePreview.fontSizePx}
                        key={codePreview.fontSizePx}
                        onChange={(fontSizePx) =>
                          updateAppearance({ codePreview: { ...codePreview, fontSizePx } })
                        }
                      />
                    </div>
                    {(
                      [
                        ["showLineNumbers", "显示行号"],
                        ["wrapLongLines", "长行自动换行"],
                      ] as const
                    ).map(([field, label]) => (
                      <div className="settings-row" key={field}>
                        <span className="settings-row-copy">
                          <strong>{label}</strong>
                        </span>
                        <span className="settings-switch">
                          <input
                            type="checkbox"
                            aria-label={label}
                            checked={codePreview[field]}
                            onChange={(event) =>
                              updateAppearance({
                                codePreview: { ...codePreview, [field]: event.target.checked },
                              })
                            }
                          />
                          <span aria-hidden="true" />
                        </span>
                      </div>
                    ))}
                  </div>
                  <h2 className="settings-label">
                    聊天 <SettingsHelp label="聊天" text="Enter 发送，Shift + Enter 换行。" />
                  </h2>
                  <div className="settings-group">
                    {(
                      [
                        [
                          "showModelPerformance",
                          "显示模型性能与用量",
                          "在输入框下方显示整个任务的性能与用量，点击查看时间和 token 明细。",
                        ],
                        [
                          "showContextUsage",
                          "显示上下文占用",
                          "在输入栏显示当前模型的上下文容量和使用情况。",
                        ],
                        [
                          "showSendButton",
                          "显示发送按钮",
                          "在输入栏右下方显示发送按钮；运行时显示停止按钮。",
                        ],
                      ] as const
                    ).map(([field, label, description]) => (
                      <div className="settings-row" key={field}>
                        <span className="settings-label">
                          <strong>{label}</strong>
                          <SettingsHelp label={label} text={description} />
                        </span>
                        <span className="settings-switch">
                          <input
                            type="checkbox"
                            aria-label={label}
                            checked={settings?.interface[field] ?? false}
                            onChange={(e) => {
                              void window.zpi
                                .updatePreferences({ [field]: e.target.checked })
                                .then(unwrap)
                                .then((value) => useStore.setState({ settings: value }))
                                .catch((e) => setError(userErrorMessage(e)));
                            }}
                          />
                          <span aria-hidden="true" />
                        </span>
                      </div>
                    ))}
                  </div>
                  {error && <div role="alert">{error}</div>}
                </div>
              ) : (
                <div className="model-provider-section">
                  <div className="resource-section-heading model-settings-toolbar">
                    <div className="model-section-actions">
                      <button
                        className="model-refresh"
                        aria-label="获取模型"
                        title="刷新模型列表"
                        disabled={
                          saving ||
                          discovering ||
                          picker ||
                          !keyReady ||
                          !url.trim() ||
                          (chatgpt && !original?.chatgptAccount?.connected)
                        }
                        onClick={() => void loadModels()}
                      >
                        <RefreshCcw size={16} className={discovering ? "spin" : undefined} />
                      </button>
                      <button
                        className="primary"
                        disabled={saving || discovering}
                        onClick={() => setPicker(true)}
                      >
                        <Plus size={14} />
                        新增提供商
                      </button>
                    </div>
                  </div>
                  <div className="settings-layout model-provider-panel">
                    <nav className="provider-list" aria-label="提供商列表">
                      <div className="provider-nav-group">
                        <h3>供应商</h3>
                        <SortableList
                          items={settings?.providers ?? []}
                          disabled={saving || discovering}
                          onReorder={(providers) => {
                            setSaving(true);
                            setError("");
                            void window.zpi
                              .reorderProviders(providers.map((provider) => provider.id))
                              .then(unwrap)
                              .then((settings) => useStore.setState({ settings }))
                              .catch((error) => setError(userErrorMessage(error)))
                              .finally(() => setSaving(false));
                          }}
                          renderItem={(
                            provider,
                            { setNodeRef, style, attributes, listeners, isDragging },
                          ) => (
                            <ActionHint appearance="control" label={provider.name} side="right">
                              <button
                                ref={setNodeRef}
                                style={style}
                                {...attributes}
                                {...listeners}
                                data-sortable-select
                                data-provider-id={provider.id}
                                className={`sortable-provider ${provider.id === selected && !picker ? "selected" : ""}${isDragging ? " dragging" : ""}`}
                                disabled={saving || discovering}
                                aria-label={provider.name}
                                onClick={() => requestSelection(() => select(provider))}
                              >
                                <ProviderLogo preset={provider.preset} size={16} />
                                <span>{provider.name}</span>
                                <i
                                  className={`provider-status ${provider.enabled === false ? "disabled" : "enabled"}`}
                                  title={provider.enabled === false ? "已关闭" : "已启用"}
                                  aria-hidden="true"
                                />
                              </button>
                            </ActionHint>
                          )}
                        />
                      </div>
                    </nav>
                    <div className="provider-editor">
                      {picker ? (
                        <section className="provider-template-picker">
                          <header>
                            {Boolean(settings?.providers.length) && (
                              <button aria-label="返回提供商" onClick={() => setPicker(false)}>
                                <ArrowLeft size={16} />
                              </button>
                            )}
                            <h2>添加模型提供商</h2>
                          </header>
                          <h3>预置与自定义供应商</h3>
                          <div className="provider-template-grid">
                            <ActionHint appearance="control" label="自定义提供商">
                              <button onClick={() => requestSelection(() => select())}>
                                <Package size={24} />
                                <span className="provider-template-label">自定义提供商</span>
                                <ChevronRight size={16} />
                              </button>
                            </ActionHint>
                            {providerPresets.map((item) => (
                              <ActionHint appearance="control" label={item.name} key={item.id}>
                                <button onClick={() => requestSelection(() => selectPreset(item.id))}>
                                  <ProviderLogo preset={item.id} size={32} />
                                  <span className="provider-template-label">{item.name}</span>
                                  <ChevronRight size={16} />
                                </button>
                              </ActionHint>
                            ))}
                          </div>
                        </section>
                      ) : (
                        <div className="provider-details">
                          <header className="provider-detail-heading">
                            <ProviderLogo preset={preset} size={20} />
                            {renaming ? (
                              <input
                                ref={renameInput}
                                className="provider-rename-input"
                                aria-label="重命名供应商"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                onBlur={() => {
                                  setRenaming(false);
                                  if (name.trim() && name.trim() !== renameStart.current)
                                    void save(models, enabled, name.trim());
                                  else setName(renameStart.current);
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") event.currentTarget.blur();
                                  if (event.key === "Escape") {
                                    event.stopPropagation();
                                    setName(renameStart.current);
                                    setRenaming(false);
                                  }
                                }}
                              />
                            ) : (
                              <h2>{name || "新提供商"}</h2>
                            )}
                            <ProviderHeadingActions
                              enabled={enabled}
                              name={name}
                              disabled={saving || discovering}
                              switchDisabled={saving || discovering || !keyReady}
                              onEnabledChange={(value) => {
                                if (selected) void save(models, value);
                                else setEnabled(value);
                              }}
                              onCloseAutoFocus={(event) => {
                                if (renameRequested.current) {
                                  event.preventDefault();
                                  renameRequested.current = false;
                                  renameInput.current?.focus();
                                  renameInput.current?.select();
                                }
                              }}
                            >
                              {selected && (
                                <>
                                  {!preset && (
                                    <>
                                      <Menu.Item
                                        className="provider-action-item"
                                        onSelect={() => {
                                          renameStart.current = name;
                                          renameRequested.current = true;
                                          setRenaming(true);
                                        }}
                                      >
                                        <Pencil size={14} />
                                        重命名
                                      </Menu.Item>
                                      <Menu.Separator className="provider-action-separator" />
                                    </>
                                  )}
                                  <Menu.Item
                                    className="provider-action-item provider-action-delete"
                                    onSelect={() => setConfirmDelete(true)}
                                  >
                                    <Trash2 size={14} />
                                    删除
                                  </Menu.Item>
                                </>
                              )}
                            </ProviderHeadingActions>
                          </header>
                          <div className="provider-connection-fields">
                            {!preset && (
                              <>
                                <label>
                                  <span>提供商名称</span>
                                  <input
                                    aria-label="提供商名称"
                                    disabled={saving || discovering}
                                    value={name}
                                    onChange={(event) => setName(event.target.value)}
                                  />
                                </label>
                                <label>
                                  <span>Base URL</span>
                                  <input
                                    aria-label="Base URL"
                                    placeholder={
                                      api === "anthropic-messages"
                                        ? "http://127.0.0.1:8000"
                                        : "http://127.0.0.1:8000/v1"
                                    }
                                    disabled={saving || discovering}
                                    value={url}
                                    onChange={(event) => setUrl(event.target.value)}
                                  />
                                </label>
                              </>
                            )}
                            {preset && !chatgpt && (
                              <label>
                                <span>Base URL</span>
                                <input aria-label="Base URL" readOnly value={url} />
                              </label>
                            )}
                            <div className="provider-api-field">
                              <label htmlFor="provider-api-format">API 格式</label>
                              <ProviderApiFormatSelect
                                value={api}
                                preset={preset}
                                disabled={chatgpt || saving || discovering || !keyReady}
                                onChange={changeApi}
                              />
                            </div>
                            {chatgpt ? (
                              <ChatGPTConnection
                                key={selected ?? "new-chatgpt"}
                                provider={original}
                                onBusy={setSaving}
                                onError={setError}
                                onNotice={setNotice}
                                onSettings={(value, providerId) => {
                                  useStore.setState({ settings: value });
                                  select(value.providers.find((provider) => provider.id === providerId));
                                  void refresh();
                                }}
                              />
                            ) : (
                              <label htmlFor="model-provider-api-key">
                                <span>API Key</span>
                                <ProviderCredentialInput
                                  id="model-provider-api-key"
                                  visible={keyVisible}
                                  onToggleVisibility={() => setKeyVisible(!keyVisible)}
                                  value={key}
                                  onChange={(event) => setKey(event.target.value)}
                                  disabled={!keyReady || saving || discovering}
                                  placeholder={keyReady ? "输入 API Key" : "正在读取凭据…"}
                                />
                              </label>
                            )}
                          </div>
                          <section className="provider-models" aria-label="模型列表">
                            <div className="model-list-heading">
                              <h3>模型列表</h3>
                              <div className="model-list-actions">
                                <button
                                  className="secondary"
                                  disabled={saving || discovering}
                                  onClick={() =>
                                    setEditing({ index: models.length, draft: draftModel(newModel(api)) })
                                  }
                                >
                                  <Plus size={14} />
                                  新增模型
                                </button>
                              </div>
                            </div>
                            {models.some((model) => model.id) ? (
                              <div className="provider-model-list">
                                <SortableList
                                  items={models.filter((model) => model.id)}
                                  disabled={saving || discovering || !keyReady || Boolean(editing)}
                                  onReorder={(next) => {
                                    setModels(next);
                                    if (selected)
                                      void save(next).then((saved) => {
                                        if (!saved) setModels(models);
                                      });
                                  }}
                                  renderItem={(
                                    model,
                                    { setNodeRef, style, attributes, listeners, isDragging },
                                  ) => {
                                    const index = models.indexOf(model);
                                    return (
                                      // biome-ignore lint/a11y/useSemanticElements: The sortable row contains independent edit, delete and switch controls.
                                      <div
                                        ref={setNodeRef}
                                        style={style}
                                        {...attributes}
                                        {...listeners}
                                        data-model-id={model.id}
                                        role="button"
                                        tabIndex={0}
                                        aria-label={`拖拽排序模型 ${model.id}`}
                                        className={`provider-model-row sortable-model${isDragging ? " dragging" : ""}`}
                                      >
                                        <div className="model-row-summary">
                                          <span className="model-row-name" title={model.name || model.id}>
                                            {model.name || model.id}
                                          </span>
                                          <span
                                            className="model-context-badge"
                                            title={`上下文窗口 ${model.contextWindow ?? modelDefaults.contextWindow}`}
                                          >
                                            {contextLabel(model.contextWindow ?? modelDefaults.contextWindow)}
                                          </span>
                                          {model.input?.includes("image") && (
                                            <span className="model-vision-badge">视觉</span>
                                          )}
                                        </div>
                                        <button
                                          disabled={saving || discovering}
                                          aria-label={`编辑模型 ${model.id}`}
                                          title="编辑模型配置"
                                          onClick={() => setEditing({ index, draft: model })}
                                        >
                                          <Pencil size={14} />
                                        </button>
                                        <button
                                          disabled={saving || discovering}
                                          aria-label={`删除模型 ${model.id}`}
                                          title="删除模型"
                                          onClick={() =>
                                            setModels(models.filter((_, item) => item !== index))
                                          }
                                        >
                                          <Trash2 size={14} />
                                        </button>
                                        <label className="settings-switch model-enabled-switch">
                                          <input
                                            type="checkbox"
                                            role="switch"
                                            aria-label={`启用模型 ${model.id}`}
                                            aria-checked={model.enabled !== false}
                                            checked={model.enabled !== false}
                                            disabled={saving || discovering || !keyReady}
                                            onChange={(event) => {
                                              const next = models.map((item, at) =>
                                                at === index
                                                  ? { ...item, enabled: event.target.checked }
                                                  : item,
                                              );
                                              if (selected) void save(next);
                                              else setModels(next);
                                            }}
                                          />
                                          <span />
                                        </label>
                                      </div>
                                    );
                                  }}
                                />
                              </div>
                            ) : (
                              <div className="provider-model-empty">
                                <Info size={16} aria-hidden="true" />
                                暂无模型，点击“新增模型”添加。
                              </div>
                            )}
                          </section>
                          <div className="provider-footer">
                            {error && (
                              <div className="run-error" role="alert">
                                {error}
                              </div>
                            )}
                            {notice && (
                              <div className="run-notice" role="status">
                                {notice}
                              </div>
                            )}
                            <div className="modal-actions">
                              <button
                                className="primary"
                                disabled={
                                  saving ||
                                  !keyReady ||
                                  (chatgpt ? !selected : Boolean(preset) && !key.trim()) ||
                                  discovering
                                }
                                onClick={() => void save()}
                              >
                                保存提供商
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <Dialog.Root
                    open={confirmDelete}
                    onOpenChange={(open) => {
                      if (!saving) setConfirmDelete(open);
                    }}
                  >
                    <Dialog.Portal>
                      <Dialog.Overlay className="model-config-backdrop" />
                      <Dialog.Content
                        className="provider-delete-dialog"
                        onOpenAutoFocus={(event) => {
                          event.preventDefault();
                          document
                            .querySelector<HTMLButtonElement>(".provider-delete-dialog .primary")
                            ?.focus();
                        }}
                        onKeyDownCapture={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.stopPropagation();
                            event.currentTarget.querySelector<HTMLButtonElement>(".primary")?.click();
                          }
                        }}
                        onEscapeKeyDown={(event) => {
                          if (saving) event.preventDefault();
                        }}
                      >
                        <header>
                          <Dialog.Title>删除供应商“{name}”？</Dialog.Title>
                          <Dialog.Description>
                            删除后将移除这条自定义 Provider 配置，当前设置页中的相关内容不会自动恢复。
                          </Dialog.Description>
                        </header>
                        {error && (
                          <div className="model-config-error" role="alert">
                            {error}
                          </div>
                        )}
                        <footer>
                          <Dialog.Close className="secondary" disabled={saving}>
                            取消<span aria-hidden="true">esc</span>
                          </Dialog.Close>
                          <button
                            className="primary"
                            disabled={saving}
                            onClick={async () => {
                              if (!selected || saving) return;
                              setSaving(true);
                              setError("");
                              try {
                                const value = unwrap(await window.zpi.deleteProvider(selected));
                                useStore.setState({ settings: value });
                                await refresh();
                                select(value.providers[0]);
                                setPicker(value.providers.length === 0);
                              } catch (error) {
                                setError(userErrorMessage(error));
                              } finally {
                                setSaving(false);
                              }
                            }}
                          >
                            确认删除<span aria-hidden="true">⏎</span>
                          </button>
                        </footer>
                      </Dialog.Content>
                    </Dialog.Portal>
                  </Dialog.Root>
                  {editing && (
                    <ModelConfigDialog
                      key={`${selected ?? preset ?? "new"}:${editing.index}`}
                      initial={editing.draft}
                      chatgpt={chatgpt}
                      api={api}
                      recommended={recommended.current.get(editing.draft.id)}
                      onClose={() => setEditing(undefined)}
                      onSave={async (model) => {
                        const next = models.slice();
                        next[editing.index] = model;
                        if (selected && !(await save(next))) throw new Error("模型保存失败，请检查配置。");
                        if (!selected) setModels(next);
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <Dialog.Root
        open={pendingSelection !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSelection(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="model-config-backdrop" />
          <Dialog.Content className="provider-delete-dialog">
            <header>
              <Dialog.Title>放弃未保存的更改？</Dialog.Title>
              <Dialog.Description>离开当前编辑会丢弃尚未保存的提供商配置。</Dialog.Description>
            </header>
            <footer>
              <Dialog.Close className="secondary">继续编辑</Dialog.Close>
              <button
                className="primary"
                onClick={() => {
                  const action = pendingSelection;
                  setPendingSelection(null);
                  action?.();
                }}
              >
                放弃更改并继续
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
