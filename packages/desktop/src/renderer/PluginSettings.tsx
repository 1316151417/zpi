import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ChevronDown, FolderOpen, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { builtinPluginMetadata, defaultPluginSettings, desktopPluginIds } from "zpi-builtin-plugins";
import type { PluginMetadata } from "zpi-coding-agent";
import type { PublicSettings, Result } from "../shared/bridge.ts";
import { memoryMode } from "../shared/plugins.ts";
import { SettingsSelect } from "./SettingsSelect.tsx";
import { refreshSuggestions, useStore } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";
import "./plugin-settings.css";

export function PluginSettings() {
  const enabled = useStore((state) => state.settings?.plugins?.enabled ?? defaultPluginSettings.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [local, setLocal] = useState<PluginMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    void window.zpi
      .getLocalPlugins()
      .then((result) => {
        if (alive) setLocal(unwrap(result));
      })
      .catch((error) => {
        if (alive) setError(userErrorMessage(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const options = useStore((state) => state.settings?.plugins?.options ?? {});
  const mode = useStore((state) => memoryMode(state.settings?.plugins ?? defaultPluginSettings));
  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      setLocal(unwrap(await window.zpi.getLocalPlugins()));
    } catch (error) {
      setError(userErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };
  const save = async (action: () => Promise<Result<PublicSettings>>) => {
    setSaving(true);
    setError("");
    try {
      useStore.setState({ settings: unwrap(await action()) });
      setLocal(unwrap(await window.zpi.getLocalPlugins()));
      const selected = useStore.getState().selected;
      if (selected) await refreshSuggestions(selected);
    } catch (error) {
      setError(userErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const toggle = (plugin: PluginMetadata) => (
    <div className="settings-row" key={plugin.id}>
      <span className="settings-row-copy">
        <strong>{plugin.name ?? plugin.id}</strong>
        <small>{plugin.description}</small>
      </span>
      <span className="settings-switch">
        <input
          type="checkbox"
          aria-label={plugin.name ?? plugin.id}
          checked={enabled[plugin.id] ?? defaultPluginSettings.enabled[plugin.id] ?? false}
          disabled={saving}
          onChange={(event) => {
            const checked = event.target.checked;
            void save(() => window.zpi.setPluginEnabled(plugin.id, checked));
          }}
        />
        <span aria-hidden="true" />
      </span>
    </div>
  );
  return (
    <div className="plugin-settings capability-settings">
      <section aria-label="已安装插件" className="plugin-section">
        <header className="plugin-section-heading">
          <h2>
            已安装 <span>{local.length}</span>
          </h2>
          <div className="plugin-actions">
            <button
              type="button"
              className="plugin-refresh"
              aria-label="刷新插件"
              title="刷新插件"
              disabled={saving || loading}
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
            <Dropdown.Root>
              <Dropdown.Trigger asChild>
                <button type="button" className="primary plugin-add" aria-label="添加插件" disabled={saving}>
                  添加
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content
                  className="selection-menu plugin-add-menu"
                  align="end"
                  sideOffset={6}
                  onEscapeKeyDown={(event) => event.stopPropagation()}
                >
                  <Dropdown.Item
                    className="menu-item"
                    onSelect={() => void save(() => window.zpi.importLocalPlugin())}
                  >
                    <FolderOpen size={15} aria-hidden="true" />
                    从本地文件夹添加
                  </Dropdown.Item>
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          </div>
        </header>
        {local.length > 0 ? (
          <div className="settings-group">{local.map(toggle)}</div>
        ) : (
          <div className="plugin-empty">
            {loading ? (
              <p role="status">正在读取插件…</p>
            ) : (
              <>
                <strong>尚未安装插件</strong>
                <p>从本地文件夹添加，复用命令、技能和自动化能力。</p>
                <button
                  type="button"
                  className="primary plugin-add"
                  disabled={saving}
                  onClick={() => void save(() => window.zpi.importLocalPlugin())}
                >
                  <Plus size={16} aria-hidden="true" />
                  添加本地插件
                </button>
              </>
            )}
          </div>
        )}
      </section>
      <section aria-label="内置插件" className="plugin-section">
        <header className="plugin-section-heading">
          <h2>
            内置插件 <span>{builtinPluginMetadata.length}</span>
          </h2>
        </header>
        <div className="settings-group">
          {builtinPluginMetadata.map(toggle)}
          <div className="settings-row">
            <span className="settings-row-copy">
              <strong>记忆模式</strong>
              <small>对新任务生效；模型和整理周期在记忆设置中配置。</small>
            </span>
            <SettingsSelect
              label="记忆模式"
              value={mode}
              options={[
                { value: "off", label: "关闭" },
                { value: "short", label: "短记忆" },
                { value: "long", label: "长期记忆" },
              ]}
              disabled={saving || enabled[desktopPluginIds.memory] === false}
              onChange={(mode) =>
                void save(() => window.zpi.setPluginOptions(desktopPluginIds.memory, { mode }))
              }
            />
          </div>
          <div className="settings-row">
            <span className="settings-row-copy">
              <strong>协作提示预设</strong>
              <small>设置新会话的子智能体调用指引。</small>
            </span>
            <SettingsSelect
              label="协作提示预设"
              value={options[desktopPluginIds.collaboration]?.promptPreset === "codex" ? "codex" : "default"}
              options={[
                { value: "default", label: "默认" },
                { value: "codex", label: "Codex" },
              ]}
              disabled={saving || enabled[desktopPluginIds.collaboration] === false}
              onChange={(promptPreset) =>
                void save(() => window.zpi.setPluginOptions(desktopPluginIds.collaboration, { promptPreset }))
              }
            />
          </div>
        </div>
      </section>
      {error && (
        <p role="alert" className="run-error">
          {error}
        </p>
      )}
    </div>
  );
}
