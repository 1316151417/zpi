import { join } from "node:path";
import { parseSubagentMarkdown } from "@zpi-dev/builtin-plugins/collaboration/profiles";
import type { SubagentProfile } from "@zpi-dev/builtin-plugins/collaboration/types";
import type { PluginSnapshot, SessionPlugin } from "@zpi-dev/coding-agent";
import {
  assertExternalPlugin,
  bindExternalPlugin,
  importLocalPlugin,
  isExternalPlugin,
} from "@zpi-dev/plugin-compat";
import type { StateStore } from "../state-store.ts";

/** Registered local imports only; project directories never imply executable plugin consent. */
export class LocalPlugins {
  readonly directory: string;
  private state: Pick<StateStore, "getSetting" | "setSetting">;
  constructor(directory: string, state: Pick<StateStore, "getSetting" | "setSetting">) {
    this.directory = join(directory, "plugins");
    this.state = state;
  }
  list(): PluginSnapshot[] {
    const plugins = this.state.getSetting<PluginSnapshot[]>("plugins.local") ?? [];
    if (!Array.isArray(plugins) || new Set(plugins.map((plugin) => plugin.id)).size !== plugins.length)
      throw new Error("storage: 本地插件列表无效");
    for (const plugin of plugins) assertExternalPlugin(plugin, this.directory);
    return structuredClone(plugins);
  }
  async import(path: string): Promise<PluginSnapshot> {
    const snapshot = await importLocalPlugin(path, this.directory);
    this.agents([snapshot]);
    const next = [...this.list().filter((plugin) => plugin.id !== snapshot.id), snapshot];
    this.state.setSetting("plugins.local", next);
    return snapshot;
  }
  enabled(enabled: Record<string, boolean>): PluginSnapshot[] {
    return this.list().filter((plugin) => enabled[plugin.id] === true);
  }
  validate(snapshot: PluginSnapshot): void {
    assertExternalPlugin(snapshot, this.directory, true);
  }
  bind(snapshot: PluginSnapshot, transcriptPath?: string): SessionPlugin {
    return bindExternalPlugin(snapshot, { storage: this.directory, transcriptPath });
  }
  agents(snapshots: readonly PluginSnapshot[]): SubagentProfile[] {
    return snapshots.filter(isExternalPlugin).flatMap((plugin) => {
      const agents = plugin.options?.agents;
      if (!Array.isArray(agents)) throw new Error("configuration: 插件 Agent 快照无效");
      return agents.map((agent) => {
        if (!agent || typeof agent !== "object" || Array.isArray(agent) || typeof agent.markdown !== "string")
          throw new Error("configuration: 插件 Agent 内容无效");
        const config = parseSubagentMarkdown(agent.markdown);
        return {
          ...config,
          id: `${plugin.id}:${config.name}`,
          name: `${plugin.name}:${config.name}`,
          scope: "plugin" as const,
          enabled: true,
        };
      });
    });
  }
}
