import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool, ThinkingLevel } from "@zpi-dev/agent";
import type { Context, Model } from "@zpi-dev/ai";
import { assertSupportedOptions, clampThinkingLevel } from "@zpi-dev/ai";
import { assembleSession, type SessionContributions, validatePluginSnapshot } from "../plugins/assembly.ts";
import type { HookRegistration } from "../plugins/hooks.ts";
import { withPluginResources } from "../plugins/resources.ts";
import { AgentSession } from "./agent-session.ts";
import type { CompactionOptions } from "./compaction.ts";
import type { ModelPerformanceTotals } from "./model-performance.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { FileResourceLoader } from "./resources.ts";
import { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { recoverCanonicalToolCallsAsync } from "./streaming-tool-journal.ts";
import { buildSystemContext, type PromptTemplate } from "./system-prompt.ts";
import { createCodingTools, FileReadState } from "./tools/index.ts";
import type { SessionCurrentState, TranscriptStore } from "./transcript-store.ts";
import type { ResourceLoader, ToolContext } from "./types.ts";
export interface SystemPromptContext {
  tools: readonly AgentTool[];
}
export interface CreateAgentSessionOptions extends SessionContributions {
  /** Build tool definitions and selection once the shared resource catalog is loaded. */
  prepareTools?: (loader: ResourceLoader) => Pick<SessionContributions, "customTools" | "tools">;
  modelRequestOptions?: () => import("@zpi-dev/ai").SimpleStreamOptions;
  onCompaction?: (
    phase: "before" | "after",
    context: { manual: boolean; instructions: string },
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Base instructions only. SDK resources and plugin context remain independently managed. */
  systemPrompt?: string | ((context: SystemPromptContext) => string);
  /** Host policy checked at each foreground model request, including continuation requests. */
  beforeModelRequest?: (model: Model, context: Context) => void;
  hooks?: readonly HookRegistration[];
  modelPerformanceTotals?: ModelPerformanceTotals;
  cwd?: string;
  agentDir?: string;
  modelRuntime?: ModelRuntime;
  model?: Model;
  thinkingLevel?: ThinkingLevel;
  /** Literal additions, recomputed after resource reload when supplied as a function. */
  customInstructions?: readonly string[] | (() => readonly string[]);
  resourceLoader?: ResourceLoader;
  /** Keep existing injected system context without rebuilding or withdrawing sections on resume. */
  preserveSystemContext?: boolean;
  sessionManager?: SessionManager;
  /** Indexed transcript and explicit current product choices. Mutually exclusive with sessionManager. */
  storage?: { transcript: TranscriptStore; currentState: SessionCurrentState };
  homeDir?: string;
  compaction?: CompactionOptions;
  settingsManager?: SettingsManager;
  promptTemplate?: () => PromptTemplate;
  projectName?: string | (() => string);
}
export interface CreateAgentSessionResult {
  session: AgentSession;
  sessionManager: SessionManager;
}
export async function createAgentSession(
  options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
  assertSupportedOptions(
    options,
    [
      "cwd",
      "prepareTools",
      "beforeModelRequest",
      "systemPrompt",
      "modelRequestOptions",
      "onCompaction",
      "agentDir",
      "modelRuntime",
      "model",
      "thinkingLevel",
      "noTools",
      "tools",
      "excludeTools",
      "customTools",
      "plugins",
      "hooks",
      "customInstructions",
      "toolOverrides",
      "resourceLoader",
      "preserveSystemContext",
      "sessionManager",
      "storage",
      "homeDir",
      "compaction",
      "settingsManager",
      "promptTemplate",
      "projectName",
      "modelPerformanceTotals",
    ],
    "createAgentSession",
  );
  if (options.preserveSystemContext !== undefined && typeof options.preserveSystemContext !== "boolean")
    throw new Error("preserveSystemContext must be boolean");
  if (options.storage !== undefined) {
    assertSupportedOptions(options.storage, ["transcript", "currentState"], "storage");
    if (options.sessionManager) throw new Error("storage and sessionManager are mutually exclusive");
    if (!options.storage.transcript || !options.storage.currentState)
      throw new Error("storage requires transcript and currentState");
    for (const method of ["get", "setModel", "setThinkingLevel", "setName"] as const)
      if (typeof options.storage.currentState[method] !== "function")
        throw new Error(`Invalid storage.currentState.${method}`);
    for (const method of [
      "getHeader",
      "getFile",
      "snapshot",
      "getStateAt",
      "getTail",
      "readEntryById",
      "readRange",
      "getContextPlan",
      "readUnresolvedToolJournals",
      "append",
      "replace",
    ] as const)
      if (typeof options.storage.transcript[method] !== "function")
        throw new Error(`Invalid storage.transcript.${method}`);
    for (const method of ["appendAsync", "replaceAsync"] as const)
      if (
        options.storage.transcript[method] !== undefined &&
        typeof options.storage.transcript[method] !== "function"
      )
        throw new Error(`Invalid storage.transcript.${method}`);
  }
  if (options.noTools !== undefined && options.noTools !== "all" && options.noTools !== "builtin")
    throw new Error("Invalid noTools");
  const managerOption =
    options.sessionManager ??
    (options.storage
      ? SessionManager.fromStore(options.storage.transcript, options.storage.currentState)
      : undefined);
  const cwd = resolve(options.cwd ?? managerOption?.getCwd() ?? process.cwd());
  const agentDir = options.agentDir ?? join(homedir(), ".zpi", "agent");
  const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  if (options.compaction) settingsManager.applyOverrides({ compaction: options.compaction });
  const runtime = options.modelRuntime ?? (await ModelRuntime.create());
  const manager = managerOption ?? SessionManager.create(cwd, join(agentDir, "sessions"));
  const restored = await manager.materializeContext();
  const selection = manager.getCurrentState();
  const available = await runtime.getAvailable();
  const model =
    options.model ??
    (selection.model ? runtime.getModel(selection.model.provider, selection.model.modelId) : available[0]);
  if (!model)
    throw new Error(selection.model ? "Recorded model is not configured" : "No callable model configured");
  if (!available.some((m) => m.provider === model.provider && m.id === model.id))
    throw new Error("Model authentication or provider is not configured");
  if (!selection.model || selection.model.modelId !== model.id || selection.model.provider !== model.provider)
    manager.appendModelChange(model.provider, model.id);
  await recoverCanonicalToolCallsAsync(manager, restored.messages);
  let session: AgentSession;
  const fileReadState = new FileReadState();
  const builtin = createCodingTools(
    cwd,
    join(agentDir, "tool-output", manager.getSessionId()),
    () => session?.model ?? model,
    () => ({
      cwd,
      model: session?.model ?? model,
      thinkingLevel: session?.thinkingLevel ?? "off",
      sessionManager: manager,
    }),
    fileReadState,
  );
  const toolContext = (signal?: AbortSignal): ToolContext => ({
    cwd,
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    sessionManager: manager,
    signal,
    isIdle: () => session.isIdle,
    getSystemPrompt: () => session.systemPrompt,
    getToolNames: () => session.state.tools.map((tool) => tool.name),
  });
  // The final loader is shared by tool preparation, prompt construction and later refreshes.
  const plugins = options.plugins ?? [];
  for (const plugin of plugins) validatePluginSnapshot(plugin);
  const baseLoader =
    options.resourceLoader ??
    new FileResourceLoader({ projectDir: manager.getCwd(), homeDir: options.homeDir });
  const loader = withPluginResources(
    baseLoader,
    plugins.flatMap((plugin) => [...(plugin.skills ?? [])]),
  );
  await loader.reload?.();
  const prepared = options.prepareTools?.(loader) ?? {};
  assertSupportedOptions(prepared, ["customTools", "tools"], "prepareTools result");
  const assembly = assembleSession({ ...options, ...prepared, builtinTools: builtin, context: toolContext });
  const { allTools: all, activeTools: active } = assembly;
  const buildContext = () => {
    let baseInstructions: string | undefined;
    if (options.systemPrompt !== undefined) {
      baseInstructions =
        typeof options.systemPrompt === "function"
          ? options.systemPrompt({
              tools: session?.state.tools ?? active,
            })
          : options.systemPrompt;
      if (typeof baseInstructions !== "string") throw new Error("Invalid systemPrompt");
    }
    const instructions =
      typeof options.customInstructions === "function"
        ? options.customInstructions()
        : options.customInstructions;
    if (
      instructions !== undefined &&
      (!Array.isArray(instructions) || instructions.some((part) => typeof part !== "string"))
    )
      throw new Error("invalid_input: customInstructions must be an array of strings");
    const context = buildSystemContext({
      cwd,
      projectName: typeof options.projectName === "function" ? options.projectName() : options.projectName,
      template: options.promptTemplate?.(),
      tools: session?.state.tools ?? active,
      loader,
      customInstructions: instructions,
      baseInstructions,
    });
    return { ...context, sections: { ...context.sections, ...assembly.getContextSections() } };
  };
  let requestedThinking = options.thinkingLevel;
  if (requestedThinking == null) {
    const hasExistingSession = restored.messages.length > 0;
    const useRecordedThinking =
      manager.hasCurrentState() || (hasExistingSession && manager.getStateAt().hasThinkingEntry);
    requestedThinking = useRecordedThinking
      ? selection.thinkingLevel
      : ((!hasExistingSession
          ? settingsManager.getModelThinkingLevel(model.provider, model.id)
          : undefined) ??
        settingsManager.getDefaultThinkingLevel() ??
        "medium");
  }
  const thinking = clampThinkingLevel(model, requestedThinking);
  if (thinking !== selection.thinkingLevel) manager.appendThinkingLevelChange(thinking);
  session = await AgentSession.create(
    model,
    runtime,
    manager,
    all,
    active,
    buildContext().base,
    thinking,
    {
      loader,
      buildContext: options.preserveSystemContext ? undefined : buildContext,
      settingsManager,
    },
    options.modelPerformanceTotals,
    {
      commands: assembly.commands,
      hooks: [...assembly.hooks, ...(options.hooks ?? [])],
      beforeModelRequest: options.beforeModelRequest,
      modelRequestOptions: options.modelRequestOptions,
      onCompaction: options.onCompaction,
    },
  );
  session.subscribe((event) => {
    if (
      (event.type === "compaction" && event.status === "completed") ||
      (event.type === "entry_appended" && event.entry.type === "microcompact")
    )
      fileReadState.clear();
  });
  return { session, sessionManager: manager };
}
