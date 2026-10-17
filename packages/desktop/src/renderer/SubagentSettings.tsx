// Adapted from ZCode settings/SubagentsSection.tsx; uses the same Lucide Bot and identity colors.
import * as Dialog from "@radix-ui/react-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  ArrowLeft,
  Bot,
  Brain,
  Check,
  ChevronDown,
  Folder,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { CombinedSelection, Result } from "../shared/bridge.ts";
import { availablePresets, modelReasoningLabel } from "../shared/config.ts";
import {
  agentColors,
  type SaveSubagentInput,
  type SubagentCatalog,
  type SubagentConfig,
  type SubagentProfile,
} from "../shared/subagents.ts";
import { ProviderLogo } from "./ProviderLogo.tsx";
import { SettingsSelect } from "./SettingsSelect.tsx";
import { useStore } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";

const agentColorLabels: Record<(typeof agentColors)[number], string> = {
  blue: "蓝色",
  cyan: "青色",
  green: "绿色",
  orange: "橙色",
  pink: "粉色",
  purple: "紫色",
  red: "红色",
  yellow: "黄色",
};

function AgentModelSelect({
  value,
  disabled,
  onChange,
  side = "bottom",
}: {
  side?: "top" | "bottom";
  value?: CombinedSelection;
  disabled: boolean;
  onChange: (value?: CombinedSelection) => void;
}) {
  const providers = useStore((state) => state.settings?.providers ?? []);
  const [query, setQuery] = useState("");
  const enabled = providers.filter((provider) => provider.enabled !== false);
  const model = enabled
    .find((provider) => provider.id === value?.provider)
    ?.models.find((model) => model.id === value?.modelId && model.enabled !== false);
  const presets = model ? availablePresets(model) : [];
  return (
    <div className="subagent-model-control">
      <Dropdown.Root onOpenChange={() => setQuery("")}>
        <Dropdown.Trigger className="settings-select-trigger" aria-label="子智能体模型" disabled={disabled}>
          <span>{value ? model?.name || (model ? model.id : "选择模型") : "继承默认"}</span>
          <ChevronDown size={14} />
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content
            side={side}
            className="settings-select-menu subagent-model-menu"
            align="end"
            sideOffset={4}
          >
            <label className="subagent-model-search">
              <Search size={14} />
              <input
                aria-label="搜索模型"
                placeholder="搜索模型..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
              />
            </label>
            {enabled.map((provider) => {
              const models = provider.models.filter(
                (model) =>
                  model.enabled !== false &&
                  `${provider.name} ${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()),
              );
              return models.length ? (
                <Dropdown.Group key={provider.id}>
                  <Dropdown.Label className="subagent-model-provider">
                    <ProviderLogo preset={provider.preset} size={16} />
                    {provider.name}
                  </Dropdown.Label>
                  {models.map((model) => (
                    <Dropdown.Item
                      key={model.id}
                      onSelect={() =>
                        onChange({
                          provider: provider.id,
                          modelId: model.id,
                          reasoning: availablePresets(model).at(-1) ?? "none",
                        })
                      }
                    >
                      <span>{model.name || model.id}</span>
                      {value?.provider === provider.id && value.modelId === model.id && <Check size={14} />}
                    </Dropdown.Item>
                  ))}
                </Dropdown.Group>
              ) : null;
            })}
            <Dropdown.Separator />
            <Dropdown.Item onSelect={() => onChange(undefined)}>
              继承默认{!value && <Check size={14} />}
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      {value && model && presets.some((preset) => preset !== "none") && (
        <span className="subagent-reasoning">
          <Brain size={14} />
          <SettingsSelect
            label="子智能体推理档位"
            value={value.reasoning}
            disabled={disabled}
            options={[
              ...(!presets.includes(value.reasoning)
                ? [{ value: value.reasoning, label: modelReasoningLabel(model, value.reasoning) }]
                : []),
              ...presets.map((preset) => ({ value: preset, label: modelReasoningLabel(model, preset) })),
            ]}
            onChange={(reasoning) => onChange({ ...value, reasoning })}
          />
        </span>
      )}
    </div>
  );
}

function AgentScopeSelect({
  label,
  value,
  disabled,
  onChange,
  sessionId,
}: {
  label: string;
  value: "user" | "workspace";
  disabled: boolean;
  onChange: (value: "user" | "workspace") => void;
  sessionId: string | null;
}) {
  const project = useStore((state) =>
    state.projects.find((project) => project.id === state.sessions.get(sessionId ?? "")?.projectId),
  );
  const workspaceName = project?.name ?? "当前项目";
  const Icon = value === "user" ? Monitor : Folder;
  return (
    <Dropdown.Root>
      <Dropdown.Trigger className="subagent-scope-trigger" aria-label={label} disabled={disabled}>
        <Icon size={16} />
        <span>{value === "user" ? "个人" : workspaceName}</span>
        <ChevronDown size={16} />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="settings-select-menu subagent-scope-menu" align="start" sideOffset={4}>
          <Dropdown.RadioGroup value={value} onValueChange={(next) => onChange(next as "user" | "workspace")}>
            <Dropdown.RadioItem value="user">
              <Monitor size={16} />
              <span>个人</span>
              <Dropdown.ItemIndicator>
                <Check size={14} />
              </Dropdown.ItemIndicator>
            </Dropdown.RadioItem>
            {sessionId && (
              <>
                <Dropdown.Separator />
                <Dropdown.Label>项目</Dropdown.Label>
                <Dropdown.RadioItem value="workspace">
                  <Folder size={16} />
                  <span>{workspaceName}</span>
                  <Dropdown.ItemIndicator>
                    <Check size={14} />
                  </Dropdown.ItemIndicator>
                </Dropdown.RadioItem>
              </>
            )}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

const blank: SubagentConfig = {
  name: "",
  description: "",
  systemPrompt: "",
  color: "blue",
  injectAgentsMd: true,
};
export function SubagentSettings() {
  const sessionId = useStore((state) => state.selected ?? null);
  const [catalog, setCatalog] = useState<SubagentCatalog>({ agents: [], diagnostics: [] });
  const providers = useStore((state) => state.settings?.providers ?? []);
  const [deleteTarget, setDeleteTarget] = useState<SubagentProfile>();
  const [listScope, setListScope] = useState<SaveSubagentInput["scope"]>("user");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<SubagentProfile | "new">();
  const [config, setConfig] = useState<SubagentConfig>(blank);
  const [scope, setScope] = useState<SaveSubagentInput["scope"]>("user");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoaded(false);
    void window.zpi
      .listSubagents(sessionId)
      .then(unwrap)
      .then((value) => {
        if (active) {
          setCatalog(value);
          setLoaded(true);
        }
      })
      .catch((error) => {
        if (active) setError(userErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [sessionId]);
  const save = async (action: () => Promise<Result<SubagentCatalog>>, close = false) => {
    setBusy(true);
    setError("");
    try {
      setCatalog(unwrap(await action()));
      if (close) setEditing(undefined);
      return true;
    } catch (error) {
      setError(userErrorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const edit = (agent?: SubagentProfile) => {
    setEditing(agent ?? "new");
    setConfig(
      agent
        ? {
            name: agent.name,
            description: agent.description,
            systemPrompt: agent.systemPrompt,
            color: agent.color,
            injectAgentsMd: agent.injectAgentsMd,
            tools: agent.tools,
            disallowedTools: agent.disallowedTools,
            modelSelection: agent.modelSelection,
          }
        : { ...blank },
    );
    setScope(agent ? (agent.scope === "workspace" ? "workspace" : "user") : listScope);
    setError("");
  };
  const selectedModel = providers
    .find((provider) => provider.enabled !== false && provider.id === config.modelSelection?.provider)
    ?.models.find((model) => model.enabled !== false && model.id === config.modelSelection?.modelId);
  const validModel =
    !config.modelSelection ||
    (selectedModel && availablePresets(selectedModel).includes(config.modelSelection.reasoning));
  const canSave =
    validModel &&
    /^[a-zA-Z0-9-]{3,50}$/.test(config.name) &&
    config.description.trim() &&
    config.systemPrompt.trim();
  const query = search.toLowerCase();
  const visibleAgents = catalog.agents.filter(
    (agent) =>
      (listScope === "user" ? agent.scope !== "workspace" : agent.scope === "workspace") &&
      `${agent.name} ${agent.description}`.toLowerCase().includes(query),
  );
  return (
    <section className="subagent-settings" aria-label="子智能体管理">
      <header className={`subagent-settings-heading${editing ? " editing" : ""}`}>
        <div>
          {editing ? (
            <button onClick={() => setEditing(undefined)} disabled={busy} aria-label="返回子智能体列表">
              <ArrowLeft size={16} />
            </button>
          ) : (
            <AgentScopeSelect
              label="子智能体列表作用域"
              value={listScope}
              disabled={busy}
              sessionId={sessionId}
              onChange={setListScope}
            />
          )}
          <h2>{editing ? (editing === "new" ? "新建子智能体" : "编辑子智能体") : "子智能体"}</h2>
          {!editing && <small>{visibleAgents.length}</small>}
        </div>
        {!editing && (
          <label className="subagent-search">
            <Search size={14} />
            <input
              aria-label="搜索子智能体"
              type="search"
              placeholder="搜索子智能体..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && (
              <button type="button" aria-label="清空搜索" onClick={() => setSearch("")}>
                <X size={14} />
              </button>
            )}
          </label>
        )}
      </header>
      {editing && (
        <p className="subagent-form-description">
          {editing === "new"
            ? "填写子智能体名称、工具和系统提示词，保存后返回列表。"
            : "修改子智能体配置，保存后返回列表。"}
        </p>
      )}
      {error && (
        <p className="run-error" role="alert">
          {error}
        </p>
      )}
      {editing ? (
        <form
          className="subagent-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave)
              void save(
                () =>
                  window.zpi.saveSubagent({
                    id: editing === "new" ? undefined : editing.id,
                    config,
                    scope,
                    sessionId,
                  }),
                true,
              );
          }}
        >
          <div className="subagent-form-scope">
            <span>作用域</span>
            <AgentScopeSelect
              label="子智能体作用域"
              value={scope}
              disabled={busy || editing !== "new"}
              sessionId={sessionId}
              onChange={setScope}
            />
          </div>
          <div className="subagent-form-identity">
            <label>
              名称
              <input
                aria-label="子智能体名称"
                placeholder="code-reviewer"
                value={config.name}
                disabled={busy}
                onChange={(event) => setConfig({ ...config, name: event.target.value })}
                pattern="[a-zA-Z0-9-]{3,50}"
                required
              />
            </label>
            <div>
              <span>颜色标记</span>
              <div role="radiogroup" aria-label="颜色标记" className="subagent-color-picker">
                {agentColors.map((color) => (
                  <label key={color} className={config.color === color ? "selected" : ""}>
                    <input
                      type="radio"
                      name="subagent-color"
                      value={color}
                      aria-label={agentColorLabels[color]}
                      checked={config.color === color}
                      disabled={busy}
                      onChange={() => setConfig({ ...config, color })}
                    />
                    <span data-agent-color={color} />
                  </label>
                ))}
              </div>
            </div>
            <div>
              <span>模型</span>
              <AgentModelSelect
                disabled={busy}
                value={config.modelSelection}
                onChange={(modelSelection) => setConfig({ ...config, modelSelection })}
              />
            </div>
          </div>
          <label>
            描述
            <input
              aria-label="子智能体描述"
              placeholder="展示给模型的简短说明"
              value={config.description}
              disabled={busy}
              required
              onChange={(event) => setConfig({ ...config, description: event.target.value })}
            />
          </label>
          <div className="subagent-tools-card">
            <div>
              <span>可用工具</span>
              <SettingsSelect
                label="可用工具范围"
                value={config.tools ? "custom" : "all"}
                disabled={busy}
                options={[
                  { value: "all", label: "默认所有权限" },
                  { value: "custom", label: "自定义可用工具" },
                ]}
                onChange={(value) =>
                  setConfig({
                    ...config,
                    tools: value === "all" ? undefined : ["read", "write", "edit", "bash"],
                  })
                }
              />
              <span className="subagent-tools-description">控制该子智能体可以调用的工具范围。</span>
            </div>
            {config.tools && (
              <div className="subagent-tool-options">
                {["read", "write", "edit", "bash"].map((tool) => (
                  <button
                    type="button"
                    key={tool}
                    aria-pressed={config.tools?.includes(tool)}
                    disabled={busy}
                    onClick={() =>
                      setConfig({
                        ...config,
                        tools: config.tools?.includes(tool)
                          ? config.tools.filter((value) => value !== tool)
                          : [...(config.tools ?? []), tool],
                      })
                    }
                  >
                    <span className={`subagent-check ${config.tools?.includes(tool) ? "selected" : ""}`}>
                      <Check size={12} />
                    </span>
                    {tool}
                    <i className={tool !== "read" ? "risky" : ""} />
                  </button>
                ))}
              </div>
            )}
          </div>
          <label>
            系统提示词
            <textarea
              aria-label="子智能体系统提示词"
              placeholder="描述这个子智能体的角色、边界和规则..."
              rows={3}
              value={config.systemPrompt}
              disabled={busy}
              required
              onChange={(event) => setConfig({ ...config, systemPrompt: event.target.value })}
            />
          </label>
          <label className="subagent-inject">
            <span>注入 AGENTS.md</span>
            <span className="settings-switch">
              <input
                type="checkbox"
                checked={config.injectAgentsMd}
                disabled={busy}
                onChange={(event) => setConfig({ ...config, injectAgentsMd: event.target.checked })}
              />
              <span />
            </span>
          </label>
          {!validModel && (
            <p role="alert" className="run-error">
              请选择可用模型和推理档位
            </p>
          )}
          <footer>
            {editing !== "new" && (
              <button
                className="subagent-delete"
                type="button"
                disabled={busy}
                onClick={() => setDeleteTarget(editing)}
              >
                <Trash2 size={14} />
                删除
              </button>
            )}
            <button className="primary" disabled={busy || !canSave}>
              保存
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(undefined)}>
              取消
            </button>
          </footer>
        </form>
      ) : (
        <>
          {!loaded && !error && <p role="status">正在加载子智能体…</p>}
          {(listScope === "user" ? (["user", "built-in"] as const) : (["workspace"] as const)).map(
            (scope) => {
              const agents = visibleAgents.filter((agent) => agent.scope === scope);
              if (!agents.length && scope === "built-in") return null;
              return (
                <section className="subagent-settings-group" key={scope}>
                  <h3>
                    {scope === "built-in" ? "内置子智能体" : "已安装"}
                    <small>{agents.length}个</small>
                    {scope !== "built-in" && (
                      <span className="subagent-group-actions">
                        <button
                          aria-label="刷新"
                          title="刷新"
                          disabled={busy}
                          onClick={() => void save(() => window.zpi.listSubagents(sessionId))}
                        >
                          <RefreshCw size={14} />
                        </button>
                        <button
                          className="primary subagent-create"
                          disabled={busy || !loaded}
                          onClick={() => edit()}
                        >
                          <Plus size={14} />
                          新建
                        </button>
                      </span>
                    )}
                  </h3>
                  {agents.length ? (
                    <div className="subagent-list">
                      {agents.map((agent) => (
                        // biome-ignore lint/a11y/noStaticElementInteractions: Only editable rows have button semantics; built-ins have no action.
                        <div
                          role={agent.scope !== "built-in" ? "button" : undefined}
                          tabIndex={agent.scope !== "built-in" ? 0 : undefined}
                          onClick={() => {
                            if (!busy && agent.scope !== "built-in") edit(agent);
                          }}
                          onKeyDown={(event) => {
                            if (
                              !busy &&
                              agent.scope !== "built-in" &&
                              event.target === event.currentTarget &&
                              ["Enter", " "].includes(event.key)
                            ) {
                              event.preventDefault();
                              edit(agent);
                            }
                          }}
                          className={`subagent-row${agent.scope !== "built-in" ? " editable" : ""}`}
                          key={agent.id}
                          data-testid={`subagent-row-${agent.name}`}
                        >
                          <div className="subagent-avatar">
                            <Bot size={16} />
                            <span data-agent-color={agent.color} />
                          </div>
                          <div className="subagent-row-copy">
                            {agent.scope !== "built-in" ? (
                              <button
                                className="subagent-edit"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  edit(agent);
                                }}
                                disabled={busy}
                              >
                                {agent.name}
                              </button>
                            ) : (
                              <strong>{agent.name}</strong>
                            )}
                            {agent.scope !== "built-in" && (
                              <span className="subagent-tools-badge">
                                {agent.modelSelection?.modelId ?? "继承默认"}
                              </span>
                            )}
                            <span className="subagent-tools-badge">
                              {!agent.tools || agent.tools.includes("*")
                                ? "全部工具"
                                : `${agent.tools.length} 个工具`}
                            </span>
                            <p title={agent.description}>{agent.description}</p>
                          </div>
                          {agent.scope === "built-in" ? (
                            <AgentModelSelect
                              side="top"
                              value={agent.modelSelection}
                              disabled={busy}
                              onChange={(modelSelection) => {
                                const {
                                  id,
                                  scope: _scope,
                                  enabled: _enabled,
                                  path: _path,
                                  ...config
                                } = agent;
                                void save(() =>
                                  window.zpi.saveSubagent({
                                    id,
                                    config: { ...config, modelSelection },
                                    scope: "user",
                                    sessionId,
                                  }),
                                );
                              }}
                            />
                          ) : (
                            <div className="subagent-row-actions">
                              {agent.scope === "user" && (
                                <label className="settings-switch">
                                  <input
                                    type="checkbox"
                                    aria-label={`切换 ${agent.name}`}
                                    checked={agent.enabled}
                                    disabled={busy}
                                    onClick={(event) => event.stopPropagation()}
                                    onKeyDown={(event) => event.stopPropagation()}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      void save(() =>
                                        window.zpi.setSubagentEnabled(agent.id, enabled, sessionId),
                                      );
                                    }}
                                  />
                                  <span />
                                </label>
                              )}
                              <button
                                aria-label={`删除 ${agent.name}`}
                                disabled={busy}
                                onKeyDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setDeleteTarget(agent);
                                }}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="subagent-empty">
                      <div>
                        <strong>没有找到子智能体</strong>
                        <p>填写子智能体名称、工具和系统提示词，保存后返回列表。</p>
                      </div>
                      <button
                        className="primary subagent-create"
                        disabled={busy || !loaded}
                        onClick={() => edit()}
                      >
                        <Plus size={14} />
                        新建
                      </button>
                    </div>
                  )}
                </section>
              );
            },
          )}
          {catalog.diagnostics.map((item) => (
            <p key={item.path} role="alert" className="run-error">
              {item.path}: {userErrorMessage(item.message)}
            </p>
          ))}
        </>
      )}
      <Dialog.Root
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteTarget(undefined);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-backdrop" />
          <Dialog.Content className="subagent-confirm" onEscapeKeyDown={(event) => event.stopPropagation()}>
            <Dialog.Title>删除子智能体</Dialog.Title>
            <Dialog.Description>
              确定要删除子智能体「{deleteTarget?.name}」吗？此操作无法撤销。
            </Dialog.Description>
            <footer>
              <button disabled={busy} onClick={() => setDeleteTarget(undefined)}>
                取消
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  if (deleteTarget)
                    void save(() => window.zpi.deleteSubagent(deleteTarget.id, sessionId), true).then(
                      (success) => {
                        if (success) setDeleteTarget(undefined);
                      },
                    );
                }}
              >
                删除
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
