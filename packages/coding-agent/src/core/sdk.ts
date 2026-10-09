import type { AgentTool, ThinkingLevel } from "ZPI-agent";
import type { Model } from "ZPI-ai";
import { assertSupportedOptions, defaultThinkingLevel } from "ZPI-ai";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession } from "./agent-session.ts";
import type { CompactionOptions } from "./compaction.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { FileResourceLoader } from "./resources.ts";
import { SessionManager } from "./session-manager.ts";
import { buildSystemPrompt, type PromptTemplate } from "./system-prompt.ts";
import { createCodingTools } from "./tools/index.ts";
import type { ResourceLoader, ToolDefinition } from "./types.ts";
export interface CreateAgentSessionOptions {
  cwd?: string;
  agentDir?: string;
  modelRuntime?: ModelRuntime;
  model?: Model;
  thinkingLevel?: ThinkingLevel;
  noTools?: "all" | "builtin";
  tools?: string[];
  excludeTools?: string[];
  customTools?: ToolDefinition[];
  resourceLoader?: ResourceLoader;
  sessionManager?: SessionManager;
  additionalSkillPaths?: string[];
  userSkillPaths?: string[];
  compaction?: CompactionOptions;
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
      "resourceLoader",
      "sessionManager",
      "additionalSkillPaths",
      "userSkillPaths",
      "compaction",
      "promptTemplate",
      "projectName",
    ],
    "createAgentSession",
  );
  if (options.noTools !== undefined && options.noTools !== "all" && options.noTools !== "builtin")
    throw new Error("Invalid noTools");
  if (options.compaction) {
    assertSupportedOptions(options.compaction, ["reserveTokens", "keepRecentTokens"], "compaction");
    for (const value of Object.values(options.compaction))
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid compaction token budget");
  }
  const cwd = resolve(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
  const agentDir = options.agentDir ?? join(homedir(), ".ZPI", "agent");
  const runtime = options.modelRuntime ?? (await ModelRuntime.create());
  const manager = options.sessionManager ?? SessionManager.create(cwd, join(agentDir, "sessions"));
  const restored = manager.buildSessionContext();
  const available = await runtime.getAvailable();
  const model =
    options.model ??
    (restored.model ? runtime.getModel(restored.model.provider, restored.model.modelId) : available[0]);
  if (!model)
    throw new Error(restored.model ? "Recorded model is not configured" : "No callable model configured");
  if (!available.some((m) => m.provider === model.provider && m.id === model.id))
    throw new Error("Model authentication or provider is not configured");
  if (!restored.model || restored.model.modelId !== model.id || restored.model.provider !== model.provider)
    manager.appendModelChange(model.provider, model.id);
  const paired = new Set(restored.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  for (const m of restored.messages)
    if (m.role === "assistant")
      for (const c of m.content)
        if (c.type === "toolCall" && c.id && c.name && !paired.has(c.id)) {
          manager.appendMessage({
            role: "toolResult",
            toolCallId: c.id,
            toolName: c.name,
            content: [
              {
                type: "text",
                text: "Interrupted: prior execution outcome and side effects are unknown. This tool was not re-executed.",
              },
            ],
            isError: true,
            timestamp: Date.now(),
          });
          paired.add(c.id);
        }
  let session: AgentSession;
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
  );
  const custom = (options.customTools ?? []).map((definition): AgentTool => {
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
  });
  const all = [...builtin, ...custom];
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
      cwd,
      agentDir,
      additionalSkillPaths: options.additionalSkillPaths,
      userSkillPaths: options.userSkillPaths,
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
  const thinking =
    options.thinkingLevel ??
    (model.defaultThinkingLevel &&
    !manager.getEntries().some((entry) => entry.type === "thinking_level_change")
      ? defaultThinkingLevel(model)
      : restored.thinkingLevel);
  if (thinking !== restored.thinkingLevel) manager.appendThinkingLevelChange(thinking);
  session = new AgentSession(model, runtime, manager, all, active, buildPrompt(), thinking, {
    loader,
    buildPrompt,
    compaction: options.compaction,
  });
  return { session };
}
