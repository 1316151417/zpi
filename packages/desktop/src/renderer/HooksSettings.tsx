import * as Dialog from "@radix-ui/react-dialog";
import { Anchor, Folder, Monitor, Plus, RefreshCw, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { Result } from "../shared/bridge.ts";
import type { ConfiguredHook, HooksCatalog, PluginHookDetail } from "../shared/hooks.ts";
import { HookForm } from "./HookForm.tsx";
import { SettingsSelect } from "./SettingsSelect.tsx";
import { useStore } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";
import "./plugin-settings.css";
import "./hooks-settings.css";

function matches(
  hook: { event: string; command: string; args?: string[]; matcher?: string; type: string },
  query: string,
) {
  return [hook.event, hook.command, hook.matcher, hook.type, ...(hook.args ?? [])].some((text) =>
    text?.toLowerCase().includes(query),
  );
}
function HookRow({
  hook,
  children,
  onEdit,
}: {
  hook: PluginHookDetail;
  children?: ReactNode;
  onEdit?: () => void;
}) {
  const copy = (
    <>
      <span className="hook-row-title">
        <strong>{hook.event}</strong>
        <span className="hook-badge">{hook.type === "native" ? "内置" : hook.type}</span>
        {hook.matcher && (
          <span className="hook-badge" title={hook.matcher}>
            {hook.matcher}
          </span>
        )}
      </span>
      <span className="hook-row-command" title={[hook.command, ...(hook.args ?? [])].join(" ")}>
        {[hook.command, ...(hook.args ?? [])].join(" ")}
      </span>
    </>
  );
  return (
    <div className="hook-row">
      <span className="hook-icon" aria-hidden="true">
        <Anchor size={18} />
      </span>
      {onEdit ? (
        <button
          type="button"
          className="hook-row-copy"
          onClick={onEdit}
          aria-label={`编辑 ${hook.event} 钩子`}
        >
          {copy}
        </button>
      ) : (
        <div className="hook-row-copy">{copy}</div>
      )}
      {children}
    </div>
  );
}
export function HooksSettings({ onOpenPlugins }: { onOpenPlugins(): void }) {
  const projects = useStore((state) => state.projects);
  const plugins = useStore((state) => state.settings?.plugins);
  const [scope, setScope] = useState("user");
  const projectId = scope === "user" ? null : scope;
  const [catalog, setCatalog] = useState<HooksCatalog>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<{ hook?: ConfiguredHook }>();
  const [deleting, setDeleting] = useState<ConfiguredHook>();
  useEffect(() => {
    let active = true;
    setLoading(true);
    setCatalog(undefined);
    setError("");
    void window.zpi
      .getHooks(projectId)
      .then(unwrap)
      .then((value) => {
        if (active) setCatalog(value);
      })
      .catch((error) => {
        if (active) setError(userErrorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, plugins]);
  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      setCatalog(unwrap(await window.zpi.getHooks(projectId)));
    } catch (error) {
      setError(userErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };
  const mutate = async (action: () => Promise<Result<HooksCatalog>>, optimistic?: HooksCatalog) => {
    if (saving) return;
    const previous = catalog;
    if (optimistic) setCatalog(optimistic);
    setSaving(true);
    setError("");
    try {
      setCatalog(unwrap(await action()));
      setForm(undefined);
      setDeleting(undefined);
    } catch (error) {
      if (optimistic) setCatalog(previous);
      setError(userErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const search = query.trim().toLowerCase();
  const hooks = (catalog?.hooks ?? []).filter((hook) => matches(hook, search));
  const groups = (catalog?.plugins ?? [])
    .map((plugin) => ({
      ...plugin,
      hooks: plugin.hooks.filter(
        (hook) => plugin.name.toLowerCase().includes(search) || matches(hook, search),
      ),
    }))
    .filter((plugin) => plugin.hooks.length);
  const count = hooks.length + groups.reduce((total, group) => total + group.hooks.length, 0);
  const create = () => {
    setError("");
    setQuery("");
    setForm({});
  };
  const scopeControl = (
    <SettingsSelect
      label="钩子范围"
      value={scope}
      disabled={saving || loading || !!form?.hook}
      options={[
        { value: "user", label: "本机 · 用户", icon: <Monitor size={16} /> },
        ...projects.map((project) => ({
          value: project.id,
          label: `本机 · ${project.name}`,
          icon: <Folder size={16} />,
        })),
      ]}
      onChange={(value) => {
        setScope(value);
        setQuery("");
      }}
    />
  );
  return (
    <div className="hooks-settings plugin-settings">
      {form ? (
        <HookForm
          key={form.hook?.id ?? "new"}
          hook={form.hook}
          projectId={projectId}
          scopeControl={scopeControl}
          saving={saving || loading}
          error={error}
          onSave={(input) => void mutate(() => window.zpi.saveHook(input))}
          onCancel={() => {
            setForm(undefined);
            setError("");
          }}
          onDelete={setDeleting}
        />
      ) : (
        <>
          <div className="hooks-toolbar">
            <div className="hooks-scope">
              {scopeControl}
              <span className="hooks-count">
                钩子 <span>{count}</span>
              </span>
            </div>
            <div className="hooks-search">
              <Search size={16} aria-hidden="true" />
              <input
                aria-label="搜索钩子"
                placeholder="搜索钩子…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}>
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
          {projectId && (
            <p className="hooks-scope-note">用户钩子也会应用于此项目，配置保存在本机应用数据中。</p>
          )}
          {error && (
            <p role="alert" className="run-error">
              {error}
            </p>
          )}
          {(!search || hooks.length > 0 || groups.length === 0) && (
            <section className="plugin-section" aria-label="已安装钩子">
              <header className="plugin-section-heading">
                <h2>
                  已安装 <span>{hooks.length}</span>
                </h2>
                <div className="plugin-actions">
                  <button
                    type="button"
                    className="plugin-refresh"
                    aria-label="刷新钩子"
                    disabled={saving || loading}
                    onClick={() => void refresh()}
                  >
                    <RefreshCw size={16} />
                  </button>
                  <button
                    type="button"
                    className="primary plugin-add"
                    disabled={saving || loading}
                    onClick={create}
                  >
                    <Plus size={14} />
                    新建
                  </button>
                </div>
              </header>
              {loading ? (
                <p role="status">正在读取钩子…</p>
              ) : hooks.length ? (
                <div className="settings-group">
                  {hooks.map((hook) => (
                    <HookRow
                      key={hook.id}
                      hook={hook}
                      onEdit={() => {
                        setError("");
                        setForm({ hook });
                      }}
                    >
                      <span className="settings-switch">
                        <input
                          type="checkbox"
                          role="switch"
                          aria-checked={hook.enabled}
                          aria-label={`启用 ${hook.event} 钩子`}
                          checked={hook.enabled}
                          disabled={saving}
                          onChange={(e) => {
                            const enabled = e.target.checked;
                            void mutate(
                              () =>
                                window.zpi.setHookEnabled(
                                  { id: hook.id, projectId: hook.projectId, expectedRevision: hook.revision },
                                  enabled,
                                ),
                              catalog && {
                                ...catalog,
                                hooks: catalog.hooks.map((row) =>
                                  row.id === hook.id ? { ...row, enabled } : row,
                                ),
                              },
                            );
                          }}
                        />
                        <span aria-hidden="true" />
                      </span>
                    </HookRow>
                  ))}
                </div>
              ) : (
                <div className="plugin-empty">
                  <strong>{search ? "未找到匹配的钩子" : "尚未安装钩子"}</strong>
                  <p>
                    {search ? "尝试其他事件、命令或插件名称。" : "新建钩子，以在任务生命周期事件中运行命令。"}
                  </p>
                  {!search && (
                    <button type="button" className="primary plugin-add" onClick={create}>
                      <Plus size={14} />
                      新建钩子
                    </button>
                  )}
                </div>
              )}
            </section>
          )}
          {groups.map((group) => (
            <section key={group.id} className="plugin-section" aria-label={`${group.name}钩子`}>
              <header className="plugin-section-heading">
                <h2>
                  {group.name} <span>{group.hooks.length}</span>
                </h2>
                <div className="hook-plugin-state">
                  <span className="hook-badge">
                    {group.builtin ? "系统内置插件" : "插件"} · {group.enabled ? "已启用" : "已停用"}
                  </span>
                  <button type="button" onClick={onOpenPlugins}>
                    管理插件
                  </button>
                </div>
              </header>
              <div className="settings-group">
                {group.hooks.map((hook, index) => (
                  <HookRow key={`${hook.event}:${index}`} hook={hook} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
      <Dialog.Root
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !saving) setDeleting(undefined);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-backdrop hook-delete-backdrop" />
          <Dialog.Content
            className="modal hook-delete-dialog"
            aria-describedby="delete-hook-description"
            onEscapeKeyDown={(e) => e.stopPropagation()}
          >
            <Dialog.Title>删除钩子？</Dialog.Title>
            <Dialog.Description id="delete-hook-description">
              删除 {deleting?.event} 钩子后，新会话将不再执行它。
            </Dialog.Description>
            {error && (
              <p role="alert" className="run-error">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" disabled={saving} onClick={() => setDeleting(undefined)}>
                取消
              </button>
              <button
                type="button"
                className="danger"
                disabled={saving}
                onClick={() => {
                  if (deleting)
                    void mutate(() =>
                      window.zpi.deleteHook({
                        id: deleting.id,
                        projectId: deleting.projectId,
                        expectedRevision: deleting.revision,
                      }),
                    );
                }}
              >
                删除
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
