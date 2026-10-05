import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Archive,
  ArrowLeft,
  Braces,
  ChevronRight,
  Eye,
  EyeOff,
  Monitor,
  Moon,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Puzzle,
  RefreshCcw,
  Settings2,
  Sparkles,
  Sun,
  Trash2,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  getProviderPreset,
  type ProviderPresetId,
  presetModels,
  providerPresets,
  usesChatGPTAuth,
} from "zpi-ai";
import { SortableList } from "zpi-ui";
import type { InterfacePreferences, ModelSettings, ProviderRecord } from "../shared/bridge.ts";
import { ArchivedTasks } from "./ArchivedTasks.tsx";
import { ChatGPTConnection } from "./ChatGPTConnection.tsx";
import { draftModel, ModelConfigDialog, type ModelDraft, serializeModel } from "./ModelConfigDialog.tsx";
import { ProviderLogo } from "./ProviderLogo.tsx";
import { ResourceSettings } from "./ResourceSettings.tsx";
import { SettingsSelect } from "./SettingsSelect.tsx";
import { refresh, unwrap, useStore } from "./store.ts";

const sections = [
  ["general", "常规", Settings2],
  ["interface", "界面设置", Monitor],
  ["prompt", "系统提示词", Sparkles],
  ["tools", "工具", Wrench],
  ["skills", "技能", Puzzle],
  ["models", "模型", Braces],
  ["archived", "已归档任务", Archive],
] as const;
type SettingsTab = (typeof sections)[number][0];

import { defaultPreferences, modelDefaults, uiFontSizeLimits } from "../shared/config.ts";

const recommendedModels = (provider?: ProviderRecord) =>
  new Map<string, ModelSettings>([
    ...presetModels(provider?.preset ?? "").map((model) => [model.id, model] as const),
    ...(provider?.models ?? [])
      .filter((model) => model.useRecommendedConfig && model.metadataSource)
      .map((model) => [model.id, model] as const),
  ]);
const contextLabel = (value: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const mergeModels = (current: ModelDraft[], discovered: ModelSettings[]) => [
  ...discovered.map((model) => {
    const old = current.find((item) => item.id === model.id);
    return old?.useRecommendedConfig === false
      ? old
      : draftModel({
          ...model,
          useRecommendedConfig: true,
          ...(old?.enabled !== undefined ? { enabled: old.enabled } : {}),
        });
  }),
  ...current.filter(
    (model) =>
      model.id && model.useRecommendedConfig === false && !discovered.some((item) => item.id === model.id),
  ),
];
const newModel = () => ({
  id: "",
  ...modelDefaults,
  input: ["text"] as ModelSettings["input"],
  useRecommendedConfig: false,
});
function FontSizeInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
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
        aria-label="界面字号"
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
  const [picker, setPicker] = useState(!settings?.providers.length);
  const [discovering, setDiscovering] = useState(false);
  const discoveryRevision = useRef(0);
  const recommended = useRef(recommendedModels(original));
  const [key, setKey] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [credentialRequest, setCredentialRequest] = useState(0);
  const [keyReady, setKeyReady] = useState(!selected);
  const [tab, setTab] = useState<SettingsTab>("interface");
  const title = sections.find(([id]) => id === tab)?.[1];
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
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
    discoveryRevision.current++;
    setDiscovering(false);
    setSelected(p?.id);
    setPreset(p?.preset);
    setPicker(false);
    setEditing(undefined);
    recommended.current = recommendedModels(p);
    setName(p?.name ?? "");
    setEnabled(p?.enabled !== false);
    setUrl(p?.baseUrl ?? "");
    setModels((p?.models ?? []).map(draftModel));

    setKey("");
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
            setKey(value.apiKey);
            setKeyReady(true);
          }
        })
        .catch((e) => {
          if (active) {
            setError(String(e));
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
          ...(preset ? { preset } : { baseUrl: url }),
          ...(selected ? { providerId: selected } : {}),
          ...(!chatgpt ? { apiKey: key } : {}),
        }),
      );
      if (revision !== discoveryRevision.current) return;
      recommended.current = new Map(result.models.map((model) => [model.id, model]));
      setModels((current) => mergeModels(current, result.models));
      setNotice(result.warning ?? `已获取 ${result.models.length} 个模型。`);
    } catch (error) {
      if (revision === discoveryRevision.current) setError(String(error));
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
    setUrl(descriptor.baseUrl);
    const catalog = presetModels(id);
    recommended.current = new Map(catalog.map((model) => [model.id, model]));
    setModels(
      catalog.map((model) => draftModel({ ...model, useRecommendedConfig: true, metadataSource: "catalog" })),
    );
  };
  const updateAppearance = (input: Partial<InterfacePreferences>) => {
    void window.zpi
      .updatePreferences(input)
      .then(unwrap)
      .then((value) => useStore.setState({ settings: value }))
      .catch((error) => setError(String(error)));
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
            apiKey: key,
          }),
        );
        nextModels = mergeModels(nextModels, result.models);
        recommended.current = new Map(result.models.map((model) => [model.id, model]));
        discoveryNotice = result.warning ?? "";
      }
      const value = unwrap(
        await window.zpi.saveProvider({
          ...(selected ? { id: selected } : {}),
          ...(preset ? { preset } : {}),
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
      setError(String(error));
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
          !event.defaultPrevented &&
          !(event.target instanceof Element && event.target.closest('[role="dialog"]'))
        )
          onClose();
      }}
    >
      <aside className="settings-sidebar">
        <div className="settings-sidebar-drag-space" aria-hidden="true" />
        <button ref={back} className="settings-back" aria-label="关闭设置" title="返回任务" onClick={onClose}>
          <ArrowLeft size={17} />
          <span>返回任务</span>
        </button>
        <nav className="settings-tabs" aria-label="设置分类">
          {sections.map(([id, label, Icon]) => (
            <button
              key={id}
              title={label}
              aria-label={label}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <div className="settings-main">
        <div className="settings-titlebar" aria-hidden="true" />
        <div className="settings-scroll">
          <div className={`settings-content ${tab === "models" ? "model-settings-content" : ""}`}>
            {tab !== "archived" && (
              <h1>{tab === "models" ? "模型设置" : tab === "interface" ? "外观" : title}</h1>
            )}
            <div className="settings-page">
              {tab === "archived" ? (
                <ArchivedTasks />
              ) : tab === "general" ? (
                <div className="general-settings">
                  <div className="settings-group">
                    {(
                      [
                        ["notificationEnabled", "任务通知", "任务完成、失败或需要确认时发送桌面通知。"],
                        ["notificationSoundEnabled", "通知声音", "通知开启后，可单独关闭任务通知提示音。"],
                      ] as const
                    ).map(([field, label, description]) => (
                      <label className="settings-row" key={field}>
                        <span className="settings-row-copy">
                          <strong>{label}</strong>
                          <small>{description}</small>
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
                      </label>
                    ))}
                  </div>
                  {error && <div role="alert">{error}</div>}
                </div>
              ) : tab === "prompt" || tab === "tools" || tab === "skills" ? (
                <ResourceSettings page={tab} />
              ) : tab === "interface" ? (
                <div className="interface-settings">
                  <h2>界面设置</h2>
                  <p className="settings-intro">设置应用主题和界面文字大小。</p>
                  <div className="settings-group">
                    <div className="settings-row">
                      <span className="settings-row-copy">
                        <strong>界面主题</strong>
                        <small>选择浅色、深色或跟随系统主题。</small>
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
                      <span className="settings-row-copy">
                        <strong>界面字号</strong>
                        <small>调整应用界面的文字大小，图标和布局尺寸不受影响。</small>
                      </span>
                      <FontSizeInput
                        key={settings?.interface.fontSize ?? defaultPreferences.fontSize}
                        value={settings?.interface.fontSize ?? defaultPreferences.fontSize}
                        onChange={(fontSize) => updateAppearance({ fontSize })}
                      />
                    </div>
                  </div>
                  <h2>聊天</h2>
                  <div className="settings-group">
                    {(
                      [
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
                      <label className="settings-row" key={field}>
                        <span className="settings-row-copy">
                          <strong>{label}</strong>
                          <small>{description}</small>
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
                                .catch((e) => setError(String(e)));
                            }}
                          />
                          <span aria-hidden="true" />
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className="settings-hint">Enter 发送 · Shift + Enter 换行</p>
                  {error && <div role="alert">{error}</div>}
                </div>
              ) : (
                <div className="model-provider-section">
                  <div className="resource-section-heading">
                    <p>管理模型供应商，配置后可在聊天时选择使用。</p>
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
                              .catch((error) => setError(String(error)))
                              .finally(() => setSaving(false));
                          }}
                          renderItem={(
                            provider,
                            { setNodeRef, style, attributes, listeners, isDragging },
                          ) => (
                            <button
                              ref={setNodeRef}
                              style={style}
                              {...attributes}
                              {...listeners}
                              data-sortable-select
                              data-provider-id={provider.id}
                              className={`sortable-provider ${provider.id === selected && !picker ? "selected" : ""}${isDragging ? " dragging" : ""}`}
                              disabled={saving || discovering}
                              title={provider.name}
                              aria-label={provider.name}
                              onClick={() => select(provider)}
                            >
                              <ProviderLogo preset={provider.preset} size={16} />
                              <span>{provider.name}</span>
                              <i
                                className={`provider-status ${provider.enabled === false ? "disabled" : "enabled"}`}
                                title={provider.enabled === false ? "已关闭" : "已启用"}
                                aria-hidden="true"
                              />
                            </button>
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
                            <button onClick={() => select()}>
                              <Package size={24} />
                              <span>自定义提供商</span>
                              <ChevronRight size={16} />
                            </button>
                            {providerPresets.map((item) => (
                              <button key={item.id} onClick={() => selectPreset(item.id)}>
                                <ProviderLogo preset={item.id} size={32} />
                                <span>{item.name}</span>
                                <ChevronRight size={16} />
                              </button>
                            ))}
                          </div>
                        </section>
                      ) : (
                        <>
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
                            <div className="provider-heading-actions">
                              <label className="settings-switch provider-enabled-switch">
                                <input
                                  type="checkbox"
                                  role="switch"
                                  aria-label={`启用供应商 ${name || "新提供商"}`}
                                  aria-checked={enabled}
                                  checked={enabled}
                                  disabled={saving || discovering || !keyReady}
                                  onChange={(event) => {
                                    if (selected) void save(models, event.target.checked);
                                    else setEnabled(event.target.checked);
                                  }}
                                />
                                <span />
                              </label>
                              {selected && (
                                <Menu.Root>
                                  <Menu.Trigger
                                    className="provider-more"
                                    aria-label="供应商操作"
                                    disabled={saving || discovering}
                                  >
                                    <MoreHorizontal size={16} />
                                  </Menu.Trigger>
                                  <Menu.Portal>
                                    <Menu.Content
                                      className="provider-actions-menu"
                                      align="end"
                                      sideOffset={2}
                                      onCloseAutoFocus={(event) => {
                                        if (renameRequested.current) {
                                          event.preventDefault();
                                          renameRequested.current = false;
                                          renameInput.current?.focus();
                                          renameInput.current?.select();
                                        }
                                      }}
                                    >
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
                                    </Menu.Content>
                                  </Menu.Portal>
                                </Menu.Root>
                              )}
                            </div>
                          </header>
                          {!preset && (
                            <div className="provider-connection-fields">
                              <label>
                                提供商名称
                                <input
                                  aria-label="提供商名称"
                                  disabled={saving || discovering}
                                  value={name}
                                  onChange={(event) => setName(event.target.value)}
                                />
                              </label>
                              <label>
                                Base URL
                                <input
                                  aria-label="Base URL"
                                  placeholder="http://127.0.0.1:8000/v1"
                                  disabled={saving || discovering}
                                  value={url}
                                  onChange={(event) => setUrl(event.target.value)}
                                />
                              </label>
                            </div>
                          )}
                          {preset && !chatgpt && (
                            <label>
                              Base URL
                              <input aria-label="Base URL" readOnly value={url} />
                            </label>
                          )}
                          <label>
                            API 格式
                            <input
                              readOnly
                              aria-label="API 格式"
                              value={
                                chatgpt
                                  ? "OpenAI Responses · ChatGPT 套餐授权"
                                  : "OpenAI Chat Completions (/v1/chat/completions)"
                              }
                            />
                          </label>
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
                            <label>
                              API Key
                              <span className="credential-input">
                                <input
                                  aria-label="API key"
                                  type={keyVisible ? "text" : "password"}
                                  autoComplete="off"
                                  value={key}
                                  onChange={(event) => setKey(event.target.value)}
                                  disabled={!keyReady || saving || discovering}
                                  placeholder={keyReady ? "输入 API Key" : "正在读取凭据…"}
                                />
                                <button
                                  type="button"
                                  aria-label={keyVisible ? "隐藏 API key" : "显示 API key"}
                                  onClick={() => setKeyVisible(!keyVisible)}
                                >
                                  {keyVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                                </button>
                              </span>
                            </label>
                          )}
                          <div className="model-list-heading">
                            <h3>模型列表</h3>
                            <div className="model-list-actions">
                              <button
                                className="secondary"
                                disabled={saving || discovering}
                                onClick={() =>
                                  setEditing({ index: models.length, draft: draftModel(newModel()) })
                                }
                              >
                                <Plus size={14} />
                                新增模型
                              </button>
                            </div>
                          </div>
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
                                      {model.availability === "unverified" && (
                                        <span
                                          className="model-context-badge"
                                          title="账号目录尚未返回该模型，调用取决于账号权限。"
                                        >
                                          预置 · 待验证
                                        </span>
                                      )}
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
                                      onClick={() => setModels(models.filter((_, item) => item !== index))}
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
                                            at === index ? { ...item, enabled: event.target.checked } : item,
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
                        </>
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
                                setError(String(error));
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
    </section>
  );
}
