import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool, ThinkingLevel } from "zpi-agent";
import type { Model } from "zpi-ai";
import { assertSupportedOptions, clampThinkingLevel } from "zpi-ai";
import { AgentSession } from "./agent-session.ts";
import type { CompactionOptions } from "./compaction.ts";
import type { ModelPerformanceTotals } from "./model-performance.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { FileResourceLoader } from "./resources.ts";
import { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { unresolvedCanonicalToolCalls } from "./streaming-tool-journal.ts";
import { buildSystemPrompt, type PromptTemplate } from "./system-prompt.ts";
import { createCodingTools, FileReadState } from "./tools/index.ts";
import type { ResourceLoader, ToolDefinition } from "./types.ts";
export interface CreateAgentSessionOptions {
  modelPerformanceTotals?: ModelPerformanceTotals;
  cwd?: string;
  agentDir?: string;
  modelRuntime?: ModelRuntime;
  model?: Model;
  thinkingLevel?: ThinkingLevel;
  noTools?: "all" | "builtin";
  tools?: string[];
  excludeTools?: string[];
  customTools?: ToolDefinition[];
  /** Explicitly replace named built-ins while preserving the other coding tools. */
  toolOverrides?: ToolDefinition[];
  resourceLoader?: ResourceLoader;
  sessionManager?: SessionManager;
  homeDir?: string;
  compaction?: CompactionOptions;
  settingsManager?: SettingsManager;
  promptTemplate?: () => PromptTemplate;
  projectName?: string | (() => string);
}
export interface CreateAgentSessionResult {
  session: AgentSession;
}
export async function createAgentSession(
  options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
  assertSupportedOptions(
    options,
    [
      "cwd",
      "agentDir",
      "modelRuntime",
      "model",
      "thinkingLevel",
      "noTools",
      "tools",
      "excludeTools",
      "customTools",
      "toolOverrides",
      "resourceLoader",
      "sessionManager",
      "homeDir",
      "compaction",
      "settingsManager",
      "promptTemplate",
      "projectName",
      "modelPerformanceTotals",
    ],
    "createAgentSession",
  );
  if (options.noTools !== undefined && options.noTools !== "all" && options.noTools !== "builtin")
    throw new Error("Invalid noTools");
  const cwd = resolve(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
  const agentDir = options.agentDir ?? join(homedir(), ".zpi", "agent");
  const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  if (options.compaction) settingsManager.applyOverrides({ compaction: options.compaction });
  const runtime = options.modelRuntime ?? (await ModelRuntime.create());
  const manager = options.sessionManager ?? SessionManager.create(cwd, join(agentDir, "sessions"));
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
  for (const call of unresolvedCanonicalToolCalls(restored.messages)) {
    manager.appendMessage({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [
        {
          type: "text",
          text: "Interrupted: prior execution outcome and side effects are unknown. This tool was not re-executed.",
        },
      ],
      isError: true,
      timestamp: Date.now(),
    });
  }
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
  const wrap = (definition: ToolDefinition): AgentTool => {
    assertSupportedOptions(
      definition,
      [
        "name",
        "label",
        "description",
        "parameters",
        "promptSnippet",
        "promptGuidelines",
        "prepareArguments",
        "executionMode",
        "metadata",
        "permission",
        "requiresUserInteraction",
        "execute",
      ],
      "custom tool",
    );
    return {
      ...definition,
      execute: (id, params, signal, onUpdate) =>
        definition.execute(id, params, signal, onUpdate, {
          cwd,
          model: session.model,
          sessionManager: manager,
          signal,
          isIdle: () => session.isIdle,
          getSystemPrompt: () => session.systemPrompt,
        }),
    };
  };
  const custom = (options.customTools ?? []).map(wrap);
  const overrides = (options.toolOverrides ?? []).map(wrap);
  if (new Set(overrides.map((tool) => tool.name)).size !== overrides.length)
    throw new Error("Duplicate tool overrides");
  for (const tool of overrides)
    if (!builtin.some((base) => base.name === tool.name))
      throw new Error(`Unknown built-in tool override: ${tool.name}`);
  const all = [
    ...builtin.map((base) => overrides.find((tool) => tool.name === base.name) ?? base),
    ...custom,
  ];
  if (new Set(all.map((t) => t.name)).size !== all.length) throw new Error("Duplicate tool names");
  const defaults = options.noTools === "all" ? [] : options.noTools === "builtin" ? custom : all;
  const selected = (options.tools ?? defaults.map((t) => t.name)).map((n) => {
    const t = all.find((t) => t.name === n);
    if (!t) throw new Error(`Unknown tool: ${n}`);
    return t;
  });
  for (const n of options.excludeTools ?? [])
    if (!all.some((t) => t.name === n)) throw new Error(`Unknown excluded tool: ${n}`);
  const active = selected.filter((t) => !options.excludeTools?.includes(t.name));
  const loader =
    options.resourceLoader ??
    new FileResourceLoader({
      projectDir: manager.getCwd(),
      homeDir: options.homeDir,
    });
  await loader.reload?.();
  const buildPrompt = () =>
    buildSystemPrompt({
      cwd,
      projectName: typeof options.projectName === "function" ? options.projectName() : options.projectName,
      template: options.promptTemplate?.(),
      tools: session?.state.tools ?? active,
      loader,
    });
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
  session = new AgentSession(
    model,
    runtime,
    manager,
    all,
    active,
    buildPrompt(),
    thinking,
    {
      loader,
      buildPrompt,
      settingsManager,
    },
    options.modelPerformanceTotals,
  );
  session.subscribe((event) => {
    if (
      (event.type === "compaction" && event.status === "completed") ||
      (event.type === "entry_appended" && event.entry.type === "microcompact")
    )
      fileReadState.clear();
  });
  return { session };
}
