import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { assertSupportedOptions, isJsonObject } from "zpi-ai";
import { type PluginSnapshot, type SessionPlugin, validatePluginSnapshot } from "zpi-coding-agent";
import { bindCommandHooks, type CommandHook, parseCommandHook } from "zpi-plugin-compat";
import type { ConfiguredHook, HookConfig, HookTarget, SaveHookInput } from "../../shared/hooks.ts";
import type { StateStore } from "../state-store.ts";

const runtime = "host.command-hooks-v1";
const pluginId = "zpi.configured-hooks";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function validateConfig(value: unknown): asserts value is HookConfig {
  if (!isJsonObject(value)) throw new Error("invalid_input: 无效钩子配置");
  assertSupportedOptions(
    value,
    ["event", "type", "command", "args", "matcher", "timeoutMs", "enabled"],
    "hook",
  );
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.event !== "string" ||
    typeof value.command !== "string" ||
    value.command.length > 16000 ||
    Buffer.byteLength(JSON.stringify(value)) > 65536 ||
    !Array.isArray(value.args) ||
    value.args.length > 128 ||
    value.args.some((arg) => typeof arg !== "string" || arg.length > 8192) ||
    typeof value.timeoutMs !== "number" ||
    (value.matcher !== undefined && (typeof value.matcher !== "string" || value.matcher.length > 1024))
  )
    throw new Error("invalid_input: 无效钩子配置");
  const { event, matcher, enabled: _, ...command } = value;
  parseCommandHook(command, event, matcher);
}
function config(hook: HookConfig): HookConfig {
  const { event, type, command, args, matcher, timeoutMs, enabled } = hook;
  return { event, type, command, args: [...args], ...(matcher ? { matcher } : {}), timeoutMs, enabled };
}

/** Explicit UI configuration only; nothing executable is discovered from project files. */
export class ConfiguredHooks {
  readonly directory: string;
  private state: Pick<StateStore, "getSetting" | "setSetting">;
  constructor(directory: string, state: Pick<StateStore, "getSetting" | "setSetting">) {
    this.directory = join(directory, "hooks");
    this.state = state;
  }
  private all(): ConfiguredHook[] {
    const value = this.state.getSetting<ConfiguredHook[]>("hooks.config") ?? [];
    if (!Array.isArray(value) || value.length > 256) throw new Error("storage: 无效钩子列表");
    for (const hook of value) {
      if (
        !isJsonObject(hook) ||
        typeof hook.id !== "string" ||
        !hook.id ||
        typeof hook.revision !== "string" ||
        !hook.revision ||
        (hook.projectId !== null && (typeof hook.projectId !== "string" || !hook.projectId))
      )
        throw new Error("storage: 无效钩子记录");
      const { id: _, revision: _revision, projectId: _projectId, ...fields } = hook;
      validateConfig(fields);
    }
    if (new Set(value.map((hook) => hook.id)).size !== value.length) throw new Error("storage: 重复钩子记录");
    return value;
  }
  list(projectId: string | null): ConfiguredHook[] {
    return structuredClone(this.all().filter((hook) => hook.projectId === projectId));
  }
  save(input: SaveHookInput): void {
    if (!isJsonObject(input)) throw new Error("invalid_input: 无效钩子配置");
    const { id, expectedRevision, projectId, ...fields } = input;
    validateConfig(fields);
    if (projectId !== null && (typeof projectId !== "string" || !projectId))
      throw new Error("invalid_input: 无效钩子范围");
    const hooks = this.all();
    if (id !== undefined) this.target(hooks, { id, projectId, expectedRevision: expectedRevision ?? "" });
    else if (hooks.length >= 256 || expectedRevision !== undefined)
      throw new Error("invalid_input: 无法新增钩子");
    const hook: ConfiguredHook = {
      ...config(fields),
      id: id ?? randomUUID(),
      projectId,
      revision: randomUUID(),
    };
    this.state.setSetting(
      "hooks.config",
      id ? hooks.map((row) => (row.id === id ? hook : row)) : [...hooks, hook],
    );
  }
  private target(hooks: ConfiguredHook[], target: HookTarget): ConfiguredHook {
    const hook = hooks.find((hook) => hook.id === target.id && hook.projectId === target.projectId);
    if (!hook) throw new Error("not_found: 钩子不存在");
    if (hook.revision !== target.expectedRevision) throw new Error("busy: 钩子已更新，请刷新后重试");
    return hook;
  }
  setEnabled(target: HookTarget, enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new Error("invalid_input: 无效钩子开关");
    const hooks = this.all();
    const hook = this.target(hooks, target);
    this.save({
      ...config(hook),
      id: hook.id,
      projectId: hook.projectId,
      expectedRevision: hook.revision,
      enabled,
    });
  }
  delete(target: HookTarget): void {
    const hooks = this.all();
    this.target(hooks, target);
    this.state.setSetting(
      "hooks.config",
      hooks.filter((hook) => hook.id !== target.id),
    );
  }
  snapshot(projectId: string | null): PluginSnapshot[] {
    const all = this.all();
    const hooks = [
      ...all.filter((hook) => hook.projectId === null),
      ...(projectId === null ? [] : all.filter((hook) => hook.projectId === projectId)),
    ]
      .filter((hook) => hook.enabled)
      .map((hook) => {
        const { event, matcher, enabled: _, ...fields } = config(hook);
        return parseCommandHook(fields, event, matcher);
      });
    return hooks.length
      ? [
          {
            id: pluginId,
            name: "自定义钩子",
            version: hash(hooks),
            runtime,
            options: JSON.parse(JSON.stringify({ hooks })),
          },
        ]
      : [];
  }
  owns(snapshot: PluginSnapshot): boolean {
    return snapshot.runtime === runtime;
  }
  validate(snapshot: PluginSnapshot): void {
    validatePluginSnapshot(snapshot);
    const hooks = snapshot.options?.hooks;
    if (
      !this.owns(snapshot) ||
      snapshot.id !== pluginId ||
      !Array.isArray(hooks) ||
      !hooks.length ||
      hooks.length > 256 ||
      snapshot.version !== hash(hooks)
    )
      throw new Error("configuration: 钩子快照无效");
    assertSupportedOptions(snapshot.options ?? {}, ["hooks"], "configured hook snapshot");
    if (
      snapshot.instructions !== undefined ||
      snapshot.commands !== undefined ||
      snapshot.skills !== undefined
    )
      throw new Error("configuration: 钩子快照包含非钩子组件");
    for (const hook of hooks) {
      if (!isJsonObject(hook)) throw new Error("configuration: 钩子快照无效");
      const { event, matcher, ...fields } = hook;
      if (typeof event !== "string") throw new Error("configuration: 钩子事件无效");
      parseCommandHook(fields, event, matcher);
    }
  }
  bind(snapshot: PluginSnapshot, transcriptPath?: string): SessionPlugin {
    this.validate(snapshot);
    return {
      ...snapshot,
      hooks: bindCommandHooks(snapshot.options?.hooks as unknown as CommandHook[], {
        root: this.directory,
        dataDirectory: join(this.directory, "data"),
        id: pluginId,
        name: "configured-hooks",
        transcriptPath,
      }),
    };
  }
}
