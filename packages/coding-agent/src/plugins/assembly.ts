import type { TSchema } from "typebox";
import type { AgentTool } from "zpi-agent";
import { assertSupportedOptions, isJsonObject } from "zpi-ai";
import { wrapToolDefinition } from "../core/tools/pi/tool-definition-wrapper.ts";
import type { ToolContext, ToolDefinition } from "../core/types.ts";
import { validateHookRegistration } from "./hooks.ts";
import type { PluginCommand, PluginSnapshot, SessionPlugin } from "./types.ts";

export interface SessionContributions {
  plugins?: readonly SessionPlugin[];
  customTools?: readonly ToolDefinition<TSchema, unknown>[];
  toolOverrides?: readonly ToolDefinition<TSchema, unknown>[];
  noTools?: "all" | "builtin";
  tools?: readonly string[];
  excludeTools?: readonly string[];
}

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]*$/;
const commandName = /^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/;
const reservedCommands = new Set(["compact"]);

export function validatePluginSnapshot(value: unknown): asserts value is PluginSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plugin snapshot");
  const plugin = value as PluginSnapshot;
  if (
    typeof plugin.id !== "string" ||
    !identifier.test(plugin.id) ||
    typeof plugin.version !== "string" ||
    !plugin.version.trim()
  )
    throw new Error("Invalid plugin identity");
  if ([plugin.name, plugin.description].some((v) => v !== undefined && typeof v !== "string"))
    throw new Error("Invalid plugin metadata");
  if (
    plugin.runtime !== undefined &&
    (typeof plugin.runtime !== "string" || !identifier.test(plugin.runtime))
  )
    throw new Error("Invalid plugin runtime");
  if (plugin.options !== undefined && !isJsonObject(plugin.options))
    throw new Error("Invalid plugin options");
  if (
    plugin.instructions !== undefined &&
    (!Array.isArray(plugin.instructions) || plugin.instructions.some((part) => typeof part !== "string"))
  )
    throw new Error("Invalid plugin instructions");
  if (
    plugin.commands !== undefined &&
    (!Array.isArray(plugin.commands) ||
      plugin.commands.some(
        (command) =>
          !command ||
          typeof command.name !== "string" ||
          !commandName.test(command.name) ||
          reservedCommands.has(command.name) ||
          typeof command.description !== "string" ||
          typeof command.prompt !== "string",
      ))
  )
    throw new Error("Invalid plugin command");
  if (
    plugin.skills !== undefined &&
    (!Array.isArray(plugin.skills) ||
      plugin.skills.some(
        (skill) =>
          !skill ||
          typeof skill.name !== "string" ||
          !commandName.test(skill.name) ||
          [skill.description, skill.path, skill.baseDir, skill.body].some((part) => typeof part !== "string"),
      ))
  )
    throw new Error("Invalid plugin skill");
}

/** Serializable field projection; snapshotPlugins also validates and copies the data. */
export function pluginSnapshotData(plugin: PluginSnapshot): PluginSnapshot {
  const { id, version, name, description, instructions, commands, skills, runtime, options } = plugin;
  return {
    id,
    version,
    name,
    description,
    instructions,
    commands,
    skills,
    runtime,
    options,
  };
}

export function snapshotPlugins(plugins: readonly SessionPlugin[]): PluginSnapshot[] {
  return plugins.map((plugin) => {
    validatePluginSnapshot(plugin);
    return structuredClone(pluginSnapshotData(plugin));
  });
}

/** Pure assembly: validate contributions and select tools without executing plugin code. */
export function assembleSession(
  options: SessionContributions & {
    builtinTools: readonly AgentTool[];
    context?: (signal?: AbortSignal) => ToolContext;
  },
) {
  if (options.noTools !== undefined && !["all", "builtin"].includes(options.noTools))
    throw new Error("Invalid noTools");
  const plugins = [...(options.plugins ?? [])];
  const identities = new Set<string>();
  const commands: PluginCommand[] = [];
  const names = new Set<string>();
  for (const plugin of plugins) {
    validatePluginSnapshot(plugin);
    assertSupportedOptions(
      plugin,
      [
        "id",
        "version",
        "name",
        "description",
        "instructions",
        "commands",
        "skills",
        "runtime",
        "options",
        "tools",
        "toolOverrides",
        "contextInstructions",
        "hooks",
      ],
      "plugin",
    );
    if (identities.has(plugin.id)) throw new Error(`Duplicate plugin: ${plugin.id}`);
    identities.add(plugin.id);
    if (plugin.contextInstructions !== undefined && typeof plugin.contextInstructions !== "function")
      throw new Error("Invalid plugin context instructions");
    for (const command of plugin.commands ?? []) {
      if (names.has(command.name)) throw new Error(`Duplicate plugin command: ${command.name}`);
      names.add(command.name);
      commands.push(structuredClone(command));
    }
    for (const hook of plugin.hooks ?? []) validateHookRegistration(hook);
  }
  const skills = plugins.flatMap((plugin) => [...(plugin.skills ?? [])]);
  if (new Set(skills.map((skill) => skill.name)).size !== skills.length)
    throw new Error("Duplicate plugin skill");
  const context =
    options.context ??
    (() => {
      throw new Error("Preview tools cannot execute");
    });
  const wrap = (tool: ToolDefinition<TSchema, unknown>) => wrapToolDefinition(tool, context, false);
  const custom = [...(options.customTools ?? []), ...plugins.flatMap((plugin) => plugin.tools ?? [])].map(
    wrap,
  );
  const overrides = [
    ...(options.toolOverrides ?? []),
    ...plugins.flatMap((plugin) => plugin.toolOverrides ?? []),
  ].map(wrap);
  if (new Set(overrides.map((tool) => tool.name)).size !== overrides.length)
    throw new Error("Duplicate tool overrides");
  for (const tool of overrides)
    if (!options.builtinTools.some((base) => base.name === tool.name))
      throw new Error(`Unknown built-in tool override: ${tool.name}`);
  const allTools = [
    ...options.builtinTools.map((base) => overrides.find((tool) => tool.name === base.name) ?? base),
    ...custom,
  ];
  if (new Set(allTools.map((tool) => tool.name)).size !== allTools.length)
    throw new Error("Duplicate tool names");
  const defaults = options.noTools === "all" ? [] : options.noTools === "builtin" ? custom : allTools;
  const activeTools = (options.tools ?? defaults.map((tool) => tool.name))
    .map((name) => {
      const tool = allTools.find((tool) => tool.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return tool;
    })
    .filter((tool) => !options.excludeTools?.includes(tool.name));
  if (new Set(activeTools.map((tool) => tool.name)).size !== activeTools.length)
    throw new Error("Duplicate selected tools");
  for (const name of options.excludeTools ?? [])
    if (!allTools.some((tool) => tool.name === name)) throw new Error(`Unknown excluded tool: ${name}`);
  return {
    allTools,
    activeTools,
    commands,
    skills,
    instructions: plugins.flatMap((plugin) => [...(plugin.instructions ?? [])]),
    getInstructions: () =>
      plugins.flatMap((plugin) => {
        const dynamic = plugin.contextInstructions?.() ?? [];
        if (!Array.isArray(dynamic) || dynamic.some((part) => typeof part !== "string"))
          throw new Error("Invalid plugin context instructions");
        return [...(plugin.instructions ?? []), ...dynamic];
      }),
    hooks: plugins.flatMap((plugin) =>
      (plugin.hooks ?? []).map((hook) => ({ ...hook, pluginId: plugin.id })),
    ),
  };
}

export function expandPluginCommand(command: PluginCommand, args: string, cwd: string): string {
  return command.prompt.replace(/{{\s*(cwd|arguments)\s*}}/g, (_, key) => (key === "cwd" ? cwd : args));
}
