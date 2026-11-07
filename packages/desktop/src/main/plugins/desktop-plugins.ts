import {
  builtinPluginHooks,
  desktopPluginIds,
  desktopPluginManifests,
  validateBuiltinPluginOptions,
} from "zpi-builtin-plugins";
import type {
  HookInput,
  HookRegistration,
  PluginSnapshot,
  SessionContributions,
  SessionPlugin,
  ToolDefinition,
} from "zpi-coding-agent";
import type { SubagentProfile } from "../../shared/subagents.ts";
import { type TaskBackend, TaskControls } from "../tasks/controls.ts";
import type { MemoryMode } from "./memory-policy.ts";
import { agentConcurrencyNote, subagentCommonNotes } from "./subagents/prompts.ts";

interface PluginContext {
  sessionId: string;
  cwd: string;
  preview?: boolean;
  profile?: SubagentProfile;
}
export interface DesktopPluginPorts {
  external?: { validate(snapshot: PluginSnapshot): void; bind(snapshot: PluginSnapshot): SessionPlugin };
  memory: {
    prepare(sessionId: string, mode: MemoryMode, signal: AbortSignal): Promise<void>;
    instructions(sessionId: string): string[];
    read(sessionId: string, path: string): void;
    schedule(sessionId: string): void;
    settled(sessionId: string): void;
  };
  titles: { fallback(sessionId: string, prompt: string): void; start(sessionId: string): void };
  notifications: {
    eligible(sessionId: string): boolean;
    send(sessionId: string, input: Extract<HookInput, { event: "Notification" }>): void;
  };
  questionTool(sessionId: string): ToolDefinition;
  webTools(): ToolDefinition[];
  background: {
    tool(sessionId: string, cwd: string, child: boolean): ToolDefinition;
    taskBackend(): TaskBackend;
  };
  collaboration: {
    tools(sessionId: string, codex: boolean): ToolDefinition[];
    childTools(sessionId: string): ToolDefinition[];
    prepare(sessionId: string, codex: boolean): void;
    listing(sessionId: string): string;
    previewListing(cwd: string, codex: boolean): string;
    taskBackend(): TaskBackend;
  };
}

const coordinatorManifest: PluginSnapshot = {
  id: desktopPluginIds.coordinator,
  runtime: "desktop.coordinator",
  version: "1",
  instructions: [subagentCommonNotes],
};
interface RuntimeContribution {
  plugin: SessionPlugin;
  backend?: TaskBackend;
}

export function validateDesktopPluginSnapshots(
  snapshots: readonly PluginSnapshot[],
  external?: (snapshot: PluginSnapshot) => void,
): void {
  for (const snapshot of snapshots) {
    const manifests = [...desktopPluginManifests, coordinatorManifest];
    const manifest = manifests.find((plugin) => plugin.id === snapshot.id);
    if (!snapshot.runtime && !manifest) continue;
    if (!manifest && snapshot.runtime && external) {
      external(snapshot);
      continue;
    }
    if (!manifest || manifest.runtime !== snapshot.runtime || manifest.version !== snapshot.version)
      throw new Error(`configuration: 插件运行时不可用或版本不匹配：${snapshot.id}`);
    validateBuiltinPluginOptions(snapshot.id, snapshot.options ?? {});
  }
}

function bindBuiltinHooks(
  snapshot: PluginSnapshot,
  handlers: Record<string, HookRegistration["handler"]>,
): HookRegistration[] {
  return builtinPluginHooks(snapshot).map(({ key, event, matcher, onError }) => {
    if (!handlers[key]) throw new Error(`Missing builtin hook handler: ${snapshot.id}:${key}`);
    return { event, matcher, onError, handler: handlers[key] };
  });
}

/** Static snapshots become native contributions through a finite, versioned host interface. */
export function resolveDesktopPlugins(
  snapshots: readonly PluginSnapshot[],
  context: PluginContext,
  ports: DesktopPluginPorts,
): SessionContributions {
  validateDesktopPluginSnapshots(snapshots, ports.external?.validate);
  const runtimes: Record<string, (snapshot: PluginSnapshot) => RuntimeContribution> = {
    "desktop.questions": (snapshot) => ({
      plugin: { ...snapshot, tools: [ports.questionTool(context.sessionId)] },
    }),
    "desktop.web-search": (snapshot) => ({ plugin: { ...snapshot, tools: ports.webTools() } }),
    "desktop.background-tasks": (snapshot) => ({
      plugin: {
        ...snapshot,
        toolOverrides: [ports.background.tool(context.sessionId, context.cwd, !!context.profile)],
      },
      backend: ports.background.taskBackend(),
    }),
    "desktop.collaboration": (snapshot) => {
      const codex = snapshot.options?.promptPreset === "codex";
      return {
        plugin: {
          ...snapshot,
          tools: ports.collaboration.tools(context.sessionId, codex),
          contextInstructions: () => [
            "<system-reminder>\nAvailable agent types for the Agent tool:\n" +
              (context.preview
                ? ports.collaboration.previewListing(context.cwd, codex)
                : ports.collaboration.listing(context.sessionId)) +
              "\n\n" +
              agentConcurrencyNote +
              "\n</system-reminder>",
          ],
          hooks: bindBuiltinHooks(snapshot, {
            prepare: () => {
              try {
                ports.collaboration.prepare(context.sessionId, codex);
              } catch (error) {
                return {
                  block: true,
                  reason: error instanceof Error ? error.message : "Agent profiles could not be prepared",
                };
              }
            },
          }),
        },
        backend: ports.collaboration.taskBackend(),
      };
    },
    "desktop.coordinator": (snapshot) => ({
      plugin: { ...snapshot, tools: ports.collaboration.childTools(context.sessionId) },
    }),
    "desktop.memory": (snapshot) => {
      const mode = (snapshot.options?.mode ?? "off") as MemoryMode;
      let scheduled = false;
      return {
        plugin: {
          ...snapshot,
          contextInstructions: () => (context.preview ? [] : ports.memory.instructions(context.sessionId)),
          hooks: context.preview
            ? []
            : bindBuiltinHooks(snapshot, {
                prepare: async (_input, signal) => {
                  await ports.memory.prepare(context.sessionId, mode, signal);
                  if (!scheduled && !context.profile && mode === "long") {
                    scheduled = true;
                    ports.memory.schedule(context.sessionId);
                  }
                },
                read: (input) => {
                  if (
                    !context.profile &&
                    "toolInput" in input &&
                    input.toolInput &&
                    typeof input.toolInput === "object" &&
                    "path" in input.toolInput &&
                    typeof input.toolInput.path === "string"
                  )
                    ports.memory.read(context.sessionId, input.toolInput.path);
                },
                settled: () => {
                  ports.memory.settled(context.sessionId);
                },
              }).filter((hook) => !context.profile || hook.event !== "PostToolUse"),
        },
      };
    },
    "desktop.session-title": (snapshot) => ({
      plugin: {
        ...snapshot,
        hooks: bindBuiltinHooks(snapshot, {
          fallback: (input) => {
            if (input.event === "InputAccepted") ports.titles.fallback(context.sessionId, input.prompt);
          },
          start: (input) => {
            if (input.event === "RunStart" && input.userInitiated) ports.titles.start(context.sessionId);
          },
        }),
      },
    }),
    "desktop.notifications": (snapshot) => ({
      plugin: {
        ...snapshot,
        hooks: bindBuiltinHooks(snapshot, {
          send: (input) => {
            if (input.event === "Notification" && ports.notifications.eligible(context.sessionId))
              ports.notifications.send(context.sessionId, input);
          },
        }),
      },
    }),
  };
  const resolved = snapshots.map((snapshot): RuntimeContribution => {
    if (!snapshot.runtime) return { plugin: snapshot };
    if (!runtimes[snapshot.runtime] && ports.external) return { plugin: ports.external.bind(snapshot) };
    return runtimes[snapshot.runtime](snapshot);
  });
  const plugins: SessionPlugin[] = resolved.map((entry) => entry.plugin);
  const backends = resolved.flatMap((entry) => (entry.backend ? [entry.backend] : []));
  if (backends.length)
    plugins.push({
      id: "zpi.task-controls",
      version: "1",
      tools: new TaskControls(backends).tools(context.sessionId),
    });
  return { plugins, ...(context.profile ? { tools: childToolNames(plugins, context.profile) } : {}) };
}

export function pluginsForSubagent(plugins: readonly PluginSnapshot[]): PluginSnapshot[] {
  return [
    ...plugins.filter(
      (plugin) =>
        ![
          desktopPluginIds.collaboration,
          desktopPluginIds.coordinator,
          desktopPluginIds.title,
          desktopPluginIds.notifications,
        ].includes(plugin.id as typeof desktopPluginIds.collaboration),
    ),
    coordinatorManifest,
  ].map((plugin) => structuredClone(plugin));
}
export function collaborationEnabled(plugins: readonly PluginSnapshot[]): boolean {
  return plugins.some((plugin) => plugin.id === desktopPluginIds.collaboration);
}
function childToolNames(plugins: readonly SessionPlugin[], profile: SubagentProfile): string[] {
  const contributed = plugins.flatMap((plugin) => (plugin.tools ?? []).map((tool) => tool.name));
  const controls = ["TaskOutput", "TaskStop"];
  const available = [
    "read",
    "bash",
    "edit",
    "write",
    ...controls.filter((tool) => contributed.includes(tool)),
    ...contributed.filter((tool) => !controls.includes(tool)),
  ];
  const active = available.filter(
    (tool) =>
      (!profile.tools || profile.tools.includes("*") || profile.tools.includes(tool)) &&
      !profile.disallowedTools?.includes(tool),
  );
  return [
    ...new Set([
      ...active,
      ...(active.includes("bash")
        ? ["TaskOutput", "TaskStop"].filter(
            (tool) => available.includes(tool) && !profile.disallowedTools?.includes(tool),
          )
        : []),
      ...available.filter((tool) => tool === "RespondToCoordinator"),
    ]),
  ];
}
