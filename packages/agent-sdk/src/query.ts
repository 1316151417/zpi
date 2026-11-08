import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  type AssistantMessage,
  abortable,
  assertSupportedOptions,
  contentText,
  type ImageContent,
} from "@zpi-dev/ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  buildSystemPrompt,
  type CreateAgentSessionOptions,
  createAgentSession,
  type ModelRuntime,
  type ResourceLoader,
  type SessionManager,
  type SessionPlugin,
  SettingsManager,
  type ToolContext,
  type ToolDefinition,
} from "@zpi-dev/coding-agent";
import { bindExternalPlugin, importLocalPlugin } from "@zpi-dev/plugin-compat";
import { type TObject, Type } from "typebox";
import { Check } from "typebox/value";
import { version as sdkVersion } from "../package.json";
import { coreHooks, lifecycleHook } from "./hooks.ts";
import { assistantMessage, emptyUsage, messageText, stableUuid, usage, userMessage } from "./messages.ts";
import { matchesRule, permissionHook, permissionRules } from "./permissions.ts";
import { pluginAgents, SdkResources } from "./resources.ts";
import { runtimeFor, selectModel, thinkingLevel } from "./runtime.ts";
import { agentDirectory, openSession, rewindFiles } from "./sessions.ts";
import { Tasks } from "./tasks.ts";
import { canonicalTools } from "./tools.ts";
import type {
  Options,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKPermissionDenial,
  SDKResultMessage,
  SDKUserMessage,
} from "./types.ts";

export interface QueryParams {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}
const allowedOptions = [
  "cwd",
  "model",
  "abortController",
  "env",
  "tools",
  "allowedTools",
  "disallowedTools",
  "canUseTool",
  "systemPrompt",
  "thinking",
  "effort",
  "maxThinkingTokens",
  "maxTurns",
  "maxBudgetUsd",
  "includePartialMessages",
  "forwardSubagentText",
  "includeHookEvents",
  "hooks",
  "persistSession",
  "resume",
  "continue",
  "forkSession",
  "resumeSessionAt",
  "sessionId",
  "title",
  "outputFormat",
  "agents",
  "agent",
  "plugins",
  "skills",
  "settingSources",
  "enableFileCheckpointing",
  "zpi",
];
export function query(params: QueryParams): Query {
  return new AgentQuery(params);
}

class AgentQuery implements Query {
  readonly [Symbol.toStringTag] = "AsyncGenerator";
  private options: Options;
  private prompt: QueryParams["prompt"];
  private controller: AbortController;
  private session?: AgentSession;
  private manager?: SessionManager;
  private runtime?: ModelRuntime;
  private loader?: ResourceLoader;
  private initialized?: Promise<void>;
  private producing?: Promise<void>;
  private output: SDKMessage[] = [];
  private requests: Promise<unknown> = Promise.resolve();
  private wake?: () => void;
  private done = false;
  private closed = false;
  private error?: unknown;
  private interrupted = false;
  private owns = true;
  private tasks = new Tasks();
  private denials: SDKPermissionDenial[] = [];
  private turns = 0;
  private totalUsage = emptyUsage();
  private modelUsage: SDKResultMessage["modelUsage"] = {};
  private totalCost = 0;
  private limit?: Exclude<SDKResultMessage["subtype"], "success">;
  private assistantId: string = randomUUID();
  private unsubscribe?: () => void;
  private pendingUser?: { uuid: string; text: string };
  private abortListener: () => void;
  constructor(params: QueryParams) {
    assertSupportedOptions(params, ["prompt", "options"], "query");
    this.options = { ...params.options };
    assertSupportedOptions(
      this.options,
      allowedOptions,
      "Agent SDK Options (permissionMode, MCP, LSP and UI are not supported)",
    );
    if (typeof params.prompt !== "string" && typeof params.prompt?.[Symbol.asyncIterator] !== "function")
      throw new Error("prompt must be a string or AsyncIterable<SDKUserMessage>");
    for (const key of ["maxTurns", "maxBudgetUsd"] as const)
      if (
        this.options[key] !== undefined &&
        (!Number.isFinite(this.options[key]) ||
          Number(this.options[key]) <= 0 ||
          (key === "maxTurns" && !Number.isSafeInteger(this.options[key])))
      )
        throw new Error(`Invalid ${key}`);
    if (this.options.skills !== undefined) {
      if (
        this.options.skills !== "all" &&
        (!Array.isArray(this.options.skills) ||
          this.options.skills.some(
            (name) => typeof name !== "string" || !/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(name),
          ))
      )
        throw new Error("skills must contain exact skill names");
      this.options.allowedTools = [...(this.options.allowedTools ?? []), "Skill"];
    }
    permissionRules(this.options.allowedTools);
    permissionRules(this.options.disallowedTools);
    this.prompt = params.prompt;
    this.controller = this.options.abortController ?? new AbortController();
    this.abortListener = () => {
      void this.session?.abort();
      this.wake?.();
    };
    this.controller.signal.addEventListener("abort", this.abortListener);
  }
  private push(message: SDKMessage): void {
    if (this.closed) return;
    if (this.output.length >= 4096) {
      this.error = new Error("SDK consumer did not drain the message stream (4096 pending messages)");
      this.controller.abort();
      return;
    }
    this.output.push(message);
    this.wake?.();
    this.wake = undefined;
  }
  private initialize(): Promise<void> {
    this.initialized ??= this.initializeSession();
    return this.initialized;
  }
  private async initializeSession(): Promise<void> {
    const options = this.options,
      cwd = resolve(options.cwd ?? process.cwd());
    this.controller.signal.throwIfAborted();
    if (options.zpi?.session) {
      if (!options.zpi.sessionManager || !options.zpi.modelRuntime)
        throw new Error("A host-owned session requires sessionManager and modelRuntime");
      if (
        options.hooks ||
        options.allowedTools ||
        options.disallowedTools ||
        options.canUseTool ||
        options.tools ||
        options.maxTurns ||
        options.maxBudgetUsd
      )
        throw new Error("Configure tool/loop policy when creating a host-owned SDK session");
      this.owns = false;
      this.session = options.zpi.session;
      this.manager = options.zpi.sessionManager;
      this.runtime = options.zpi.modelRuntime;
    } else {
      this.runtime = await runtimeFor(options);
      const model = await selectModel(this.runtime, options.model);
      this.manager = await openSession(options, cwd);
      if (options.title && !this.manager.getEntries().some((entry) => entry.type === "session_info"))
        this.manager.appendSessionInfo(options.title);
      const directory = agentDirectory(options.zpi),
        cache = join(directory, "plugins");
      const imported: SessionPlugin[] = [];
      const agents = { ...options.agents };
      for (const plugin of options.plugins ?? []) {
        if (plugin.type !== "local") throw new Error("Only local plugins are supported");
        const snapshot = await importLocalPlugin(resolve(cwd, plugin.path), cache);
        Object.assign(agents, pluginAgents(snapshot));
        imported.push(
          bindExternalPlugin(snapshot, {
            storage: cache,
            transcriptPath: this.manager.getSessionFile(),
            env: options.env,
          }),
        );
      }
      options.agents = { ...agents, ...options.agents };
      const plugins = [...(options.zpi?.plugins ?? []), ...imported].map((plugin) =>
        options.skills && options.skills !== "all"
          ? {
              ...plugin,
              skills: plugin.skills?.filter(
                (skill) => options.skills === "all" || options.skills?.includes(skill.name),
              ),
            }
          : plugin,
      );
      const context = (): ToolContext => {
        if (!this.session || !this.manager) throw new Error("Session is not initialized");
        return {
          cwd,
          model: this.session.model,
          thinkingLevel: this.session.thinkingLevel,
          sessionManager: this.manager,
          isIdle: () => this.session?.isIdle ?? true,
          getSystemPrompt: () => this.session?.systemPrompt ?? "",
          getToolNames: () => this.session?.state.tools.map((tool) => tool.name) ?? [],
        };
      };
      const primary = options.agent ? options.agents?.[options.agent] : undefined;
      if (options.agent && !primary) throw new Error(`Unknown agent: ${options.agent}`);
      const selection = primary?.tools ?? (Array.isArray(options.tools) ? options.tools : undefined);
      const outputDir = join(directory, "tool-output", this.manager.getSessionId());
      const prepareTools = (loader: ResourceLoader) => {
        this.loader = loader;
        const tools: ToolDefinition[] = [
          ...(selection?.length === 0 ? [] : canonicalTools(cwd, outputDir, context, options, this.tasks)),
          ...(options.zpi?.customTools ?? []),
        ];
        if (this.loader.listSkills?.().skills.length)
          tools.push({
            name: "Skill",
            label: "Skill",
            description: "Load a skill by name and follow its instructions.",
            parameters: Type.Object({ skill: Type.String(), args: Type.Optional(Type.String()) }),
            execute: async (_id, input: Record<string, unknown>) => {
              const skill = await this.loader?.loadSkill?.(String(input.skill));
              if (!skill) throw new Error("Unknown skill");
              return {
                content: [
                  {
                    type: "text",
                    text: `${skill.body}\n\nSkill directory: ${skill.baseDir}\nArguments: ${input.args ?? ""}`,
                  },
                ],
                details: undefined,
              };
            },
          });
        if (Object.keys(options.agents ?? {}).length) tools.push(this.agentTool());
        const declared = [
          ...tools.map((tool) => tool.name),
          ...plugins.flatMap((plugin) => (plugin.tools ?? []).map((tool) => tool.name)),
        ];
        const disabled = new Set(
          permissionRules(options.disallowedTools)
            .filter((rule) => rule.argument === undefined)
            .flatMap((rule) => declared.filter((name) => matchesRule(rule, name, {}, cwd))),
        );
        const names = (Array.isArray(options.tools) ? options.tools : declared).filter(
          (name) => !disabled.has(name),
        );
        return { customTools: tools, tools: primary?.tools?.filter((name) => !disabled.has(name)) ?? names };
      };
      const systemPrompt: Exclude<CreateAgentSessionOptions["systemPrompt"], string | undefined> = ({
        tools,
        pluginInstructions,
        resourceLoader,
      }) => {
        const value = options.systemPrompt;
        const skills = resourceLoader.listSkills?.().skills ?? [];
        const custom =
          typeof value === "string"
            ? value
            : Array.isArray(value)
              ? value.join("\n\n")
              : value?.type === "custom"
                ? [value.prompt].flat().join("\n\n")
                : value?.type === "preset"
                  ? buildSystemPrompt({ cwd, tools })
                  : "You are a helpful assistant.";
        return [
          primary?.prompt ?? custom,
          typeof value === "object" && !Array.isArray(value) && value.type === "preset"
            ? value.append
            : undefined,
          ...(resourceLoader.getInstructions?.() ?? []),
          ...pluginInstructions,
          ...(Object.keys(options.agents ?? {}).length
            ? [
                `Available agents:\n${Object.entries(options.agents ?? {})
                  .map(([name, agent]) => `${name}: ${agent.description}`)
                  .join("\n")}`,
              ]
            : []),
          ...(skills.length
            ? [
                `Available skills:\n${skills
                  .map((skill) => `${skill.name}: ${skill.description}`)
                  .join("\n")}`,
              ]
            : []),
          ...(options.outputFormat
            ? [`Return only JSON satisfying this schema: ${JSON.stringify(options.outputFormat.schema)}`]
            : []),
        ]
          .filter(Boolean)
          .join("\n\n");
      };
      const hooks = [
        ...coreHooks(options, this.manager.getSessionFile() ?? ""),
        permissionHook(options, this.denials, () => {
          this.interrupted = true;
          void this.session?.abort();
        }),
      ];
      const created = await createAgentSession({
        cwd,
        agentDir: directory,
        modelRuntime: this.runtime,
        model: primary?.model ? await selectModel(this.runtime, primary.model) : model,
        thinkingLevel: thinkingLevel(options),
        modelRequestOptions: () => {
          const request =
            typeof this.options.zpi?.requestOptions === "function"
              ? this.options.zpi.requestOptions()
              : this.options.zpi?.requestOptions;
          const budget =
            this.options.maxThinkingTokens ??
            (this.options.thinking?.type === "enabled" ? this.options.thinking.budgetTokens : undefined);
          return budget && budget > 0
            ? {
                ...request,
                thinkingBudgets: {
                  minimal: budget,
                  low: budget,
                  medium: budget,
                  high: budget,
                  xhigh: budget,
                  max: budget,
                },
              }
            : (request ?? {});
        },
        onCompaction: (phase, data, signal) =>
          lifecycleHook(
            options,
            phase === "before" ? "PreCompact" : "PostCompact",
            {
              session_id: this.manager?.getSessionId() ?? "",
              transcript_path: this.manager?.getSessionFile() ?? "",
              cwd,
              trigger: data.manual ? "manual" : "auto",
              custom_instructions: data.instructions ?? "",
            },
            signal ?? this.controller.signal,
          ),
        sessionManager: this.manager,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
        resourceLoader: options.zpi?.resourceLoader ?? new SdkResources(options, cwd),
        systemPrompt,
        plugins,
        prepareTools,
        noTools: "builtin",
        hooks,
        beforeModelRequest: () => {
          if (
            (options.maxTurns !== undefined && this.turns >= options.maxTurns) ||
            (options.maxBudgetUsd !== undefined && this.totalCost >= options.maxBudgetUsd)
          ) {
            this.limit =
              options.maxTurns !== undefined && this.turns >= options.maxTurns
                ? "error_max_turns"
                : "error_max_budget_usd";
            this.controller.abort(new Error(this.limit));
            throw new Error(this.limit);
          }
          this.turns++;
        },
      });
      this.session = created.session;
    }
    this.unsubscribe = this.session.subscribe((event) => this.observe(event));
    this.push({
      type: "system",
      subtype: "init",
      uuid: randomUUID(),
      session_id: this.session.sessionId,
      cwd: this.manager.getCwd(),
      model: this.session.model.id,
      tools: this.session.state.tools.map((tool) => tool.name),
      apiKeySource: options.zpi?.providers || options.zpi?.modelRuntime ? "user" : "env",
      claude_code_version: `zpi/${sdkVersion}`,
      mcp_servers: [],
      slash_commands: this.session.listCommands().map((command) => command.name),
      output_style: "default",
      skills: this.loader?.listSkills?.().skills.map((skill) => skill.name) ?? [],
      plugins: (options.plugins ?? []).map((plugin) => ({ name: plugin.path, path: plugin.path })),
      agents: Object.keys(options.agents ?? {}),
      capabilities: ["zpi_sdk_v1"],
    });
  }
  private observe(event: AgentSessionEvent): void {
    if (!this.session || !this.manager) return;
    const sessionId = this.session.sessionId;
    const stream = (value: SDKPartialAssistantMessage["event"]) => {
      if (this.options.includePartialMessages)
        this.push({
          type: "stream_event",
          uuid: randomUUID(),
          session_id: sessionId,
          parent_tool_use_id: null,
          event: value,
        });
    };
    if (event.type === "message_start" && event.message.role === "assistant") {
      if (!this.owns) this.turns++;
      this.assistantId = randomUUID();
      stream({
        type: "message_start",
        message: assistantMessage(event.message, sessionId, this.assistantId).message,
      });
    } else if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta.type === "text_start" || delta.type === "thinking_start" || delta.type === "toolcall_start") {
        const part = delta.partial.content[delta.contentIndex];
        stream({
          type: "content_block_start",
          index: delta.contentIndex,
          content_block:
            part?.type === "toolCall"
              ? { type: "tool_use", id: part.id, name: part.name, input: {} }
              : part?.type === "thinking"
                ? { type: "thinking", thinking: "", signature: "" }
                : { type: "text", text: "" },
        });
      } else if (
        delta.type === "text_delta" ||
        delta.type === "thinking_delta" ||
        delta.type === "toolcall_delta"
      )
        stream({
          type: "content_block_delta",
          index: delta.contentIndex,
          delta:
            delta.type === "text_delta"
              ? { type: "text_delta", text: delta.delta }
              : delta.type === "thinking_delta"
                ? { type: "thinking_delta", thinking: delta.delta }
                : { type: "input_json_delta", partial_json: delta.delta },
        });
      else if (delta.type === "text_end" || delta.type === "thinking_end" || delta.type === "toolcall_end")
        stream({ type: "content_block_stop", index: delta.contentIndex });
    } else if (event.type === "message_end") {
      const entry = this.manager.getLastEntry(),
        uuid =
          entry?.type === "message"
            ? event.message.role === "user" &&
              this.pendingUser &&
              messageText(event.message) === this.pendingUser.text
              ? this.pendingUser.uuid
              : stableUuid(entry.id)
            : randomUUID();
      if (event.message.role === "assistant") {
        const message = assistantMessage(event.message, sessionId, uuid);
        this.addUsage(event.message);
        stream({
          type: "message_delta",
          delta: { stop_reason: message.message.stop_reason, stop_sequence: null },
          usage: message.message.usage,
        });
        stream({ type: "message_stop" });
        this.push(message);
      } else if (event.message.role === "user" || event.message.role === "toolResult") {
        if (uuid === this.pendingUser?.uuid) this.pendingUser = undefined;
        this.push(userMessage(event.message, sessionId, uuid));
      }
    } else if (
      event.type === "hook_execution" &&
      (this.options.includeHookEvents || event.execution.event === "SessionStart")
    )
      this.push({
        type: "system",
        subtype: "hook_response",
        uuid: randomUUID(),
        session_id: sessionId,
        hook_id: `${event.execution.invocationId}:${event.execution.index}`,
        hook_name: event.execution.pluginId ?? "sdk",
        hook_event: event.execution.event,
        output: "",
        stdout: "",
        stderr: "",
        exit_code: event.execution.status === "completed" ? 0 : 1,
        outcome:
          event.execution.status === "completed"
            ? "success"
            : event.execution.status === "cancelled"
              ? "cancelled"
              : "error",
      });
    else if (event.type === "compaction" && event.status === "completed")
      this.push({
        type: "system",
        subtype: "compact_boundary",
        uuid: randomUUID(),
        session_id: sessionId,
        compact_metadata: { trigger: event.origin, pre_tokens: 0 },
      });
  }
  private addUsage(message: AssistantMessage): void {
    const value = usage(message.usage);
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ] as const)
      this.totalUsage[key] += value[key];
    this.totalCost += message.usage.cost.total;
    const model = this.session?.model;
    this.modelUsage[message.model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: model?.contextWindow ?? 0,
      maxOutputTokens: model?.maxTokens ?? 0,
    };
    const row = this.modelUsage[message.model];
    row.inputTokens += value.input_tokens;
    row.outputTokens += value.output_tokens;
    row.cacheReadInputTokens += value.cache_read_input_tokens;
    row.cacheCreationInputTokens += value.cache_creation_input_tokens;
    row.costUSD += message.usage.cost.total;
  }
  private agentTool(): ToolDefinition<TObject> {
    return {
      name: "Agent",
      label: "Agent",
      description: "Delegate a task to one of the configured agents. Background runs return task_id.",
      parameters: Type.Object({
        description: Type.String(),
        prompt: Type.String(),
        subagent_type: Type.String(),
        run_in_background: Type.Optional(Type.Boolean()),
      }),
      execute: async (toolId, input, signal) => {
        const definition = this.options.agents?.[String(input.subagent_type)];
        if (!definition) throw new Error("Unknown subagent_type");
        const run = async (childSignal: AbortSignal): Promise<string> => {
          const controller = new AbortController(),
            abort = () => controller.abort(childSignal.reason);
          childSignal.addEventListener("abort", abort, { once: true });
          try {
            const childOptions: Options = {
              ...this.options,
              agents: undefined,
              agent: undefined,
              includePartialMessages:
                !!this.options.forwardSubagentText && !!this.options.includePartialMessages,
              resume: undefined,
              continue: undefined,
              forkSession: undefined,
              sessionId: undefined,
              title: undefined,
              tools:
                definition.tools ??
                this.session?.state.tools.map((tool) => tool.name).filter((name) => name !== "Agent"),
              disallowedTools: [
                ...(this.options.disallowedTools ?? []),
                ...(definition.disallowedTools ?? []),
              ],
              systemPrompt: definition.prompt,
              model:
                definition.model === "inherit"
                  ? this.options.model
                  : (definition.model ?? this.options.model),
              effort: definition.effort ?? this.options.effort,
              skills: definition.skills ?? this.options.skills,
              maxTurns: definition.maxTurns ?? this.options.maxTurns,
              persistSession: false,
              abortController: controller,
              zpi: {
                ...this.options.zpi,
                modelRuntime: this.runtime,
                session: undefined,
                sessionManager: undefined,
                input: undefined,
              },
            };
            await lifecycleHook(
              this.options,
              "SubagentStart",
              {
                session_id: this.session?.sessionId ?? "",
                transcript_path: this.manager?.getSessionFile() ?? "",
                cwd: this.manager?.getCwd() ?? "",
                agent_id: toolId,
                agent_type: String(input.subagent_type),
              },
              controller.signal,
            );
            let result = "";
            for await (const message of query({ prompt: String(input.prompt), options: childOptions })) {
              if (message.type === "result") {
                this.totalCost += message.total_cost_usd;
                for (const key of [
                  "input_tokens",
                  "output_tokens",
                  "cache_read_input_tokens",
                  "cache_creation_input_tokens",
                ] as const)
                  this.totalUsage[key] += message.usage[key];
                for (const [name, usage] of Object.entries(message.modelUsage)) {
                  const prior = this.modelUsage[name];
                  if (!prior) this.modelUsage[name] = { ...usage };
                  else
                    for (const key of [
                      "inputTokens",
                      "outputTokens",
                      "cacheReadInputTokens",
                      "cacheCreationInputTokens",
                      "webSearchRequests",
                      "costUSD",
                    ] as const)
                      prior[key] += usage[key];
                }
                if (message.subtype !== "success") throw new Error(message.errors.join("\n"));
                result = message.result;
              } else if (
                this.options.forwardSubagentText &&
                (message.type === "assistant" || message.type === "user" || message.type === "stream_event")
              )
                this.push({ ...message, parent_tool_use_id: toolId });
            }
            await lifecycleHook(
              this.options,
              "SubagentStop",
              {
                stop_hook_active: false,
                last_assistant_message: result,
                session_id: this.session?.sessionId ?? "",
                transcript_path: this.manager?.getSessionFile() ?? "",
                cwd: this.manager?.getCwd() ?? "",
                agent_id: toolId,
                agent_type: String(input.subagent_type),
              },
              controller.signal,
            );
            return result;
          } finally {
            childSignal.removeEventListener("abort", abort);
          }
        };
        return {
          content: [
            {
              type: "text",
              text: input.run_in_background
                ? JSON.stringify({ task_id: this.tasks.start(run) })
                : await run(signal ?? new AbortController().signal),
            },
          ],
          details: undefined,
        };
      },
    };
  }
  private async produce(): Promise<void> {
    try {
      await this.initialize();
      const iterator = typeof this.prompt === "string" ? undefined : this.prompt[Symbol.asyncIterator]();
      try {
        do {
          this.controller.signal.throwIfAborted();
          const next = iterator
            ? await abortable(iterator.next(), this.controller.signal)
            : {
                done: false as const,
                value: {
                  type: "user" as const,
                  uuid: randomUUID(),
                  parent_tool_use_id: null,
                  message: { role: "user" as const, content: this.prompt as string },
                },
              };
          if (next.done) break;
          await this.turn(next.value);
          if (!iterator) break;
        } while (!this.controller.signal.aborted);
      } finally {
        void iterator?.return?.().catch(() => {});
      }
    } catch (error) {
      if (!this.closed && !this.limit) this.error = error;
    } finally {
      if (this.owns && this.session && this.manager) {
        try {
          await lifecycleHook(
            this.options,
            "SessionEnd",
            {
              session_id: this.session.sessionId,
              transcript_path: this.manager.getSessionFile() ?? "",
              cwd: this.manager.getCwd(),
              reason: this.closed ? "other" : "prompt_input_exit",
            },
            new AbortController().signal,
          );
        } catch (error) {
          this.error ??= error;
        }
      }
      this.unsubscribe?.();
      this.controller.signal.removeEventListener("abort", this.abortListener);
      await this.tasks.close();
      if (this.owns) this.session?.dispose();
      this.done = true;
      this.wake?.();
    }
  }
  private async turn(input: SDKUserMessage): Promise<void> {
    if (!this.session || !this.manager) throw new Error("Session unavailable");
    if (input.type !== "user" || input.message?.role !== "user")
      throw new Error("Streaming input must contain SDKUserMessage values");
    if (input.session_id && input.session_id !== this.session.sessionId)
      throw new Error("Input session_id does not match the active session");
    const content = input.message.content;
    const text = contentText(content);
    if (typeof content !== "string" && content.some((block) => block.type === "tool_result"))
      throw new Error("External tool_result prompt injection is unsupported");
    const images: ImageContent[] =
      typeof content === "string"
        ? []
        : content
            .filter((block) => block.type === "image")
            .map((block) => ({ type: "image", data: block.source.data, mimeType: block.source.media_type }));
    this.turns = 0;
    this.totalCost = 0;
    this.totalUsage = emptyUsage();
    this.modelUsage = {};
    this.denials.splice(0);
    this.interrupted = false;
    this.limit = undefined;
    const start = Date.now(),
      apiStart = this.session.modelPerformance.llmMs ?? 0,
      priorAssistant = this.session.messages.findLast((message) => message.role === "assistant");
    let failure: unknown;
    let structured: unknown;
    try {
      if (this.owns) {
        this.pendingUser = { uuid: input.uuid ?? randomUUID(), text };
        await this.manager.appendCustomEntryAsync("sdk.user", this.pendingUser);
      }
      if (this.options.zpi?.input)
        await this.session.executeInput(this.options.zpi.input.parsed, this.options.zpi.input.context);
      else {
        const prepared = await this.session.prepareInput(text, { images });
        await this.session.executeInput(prepared, { images });
      }
      if (this.options.outputFormat) {
        for (let retry = 0; retry < 3; retry++) {
          const last = this.session.messages.findLast((message) => message.role === "assistant");
          try {
            structured = JSON.parse(last ? messageText(last).replace(/^```(?:json)?\s*|\s*```$/g, "") : "");
            if (!Check(Type.Unsafe(this.options.outputFormat.schema), structured))
              throw new Error("Output does not match schema");
            break;
          } catch {
            if (retry === 2 || this.controller.signal.aborted) {
              this.limit ??= "error_max_structured_output_retries";
              break;
            }
            await this.session.prompt("Return the final answer as JSON only, matching the provided schema.");
          }
        }
      }
    } catch (error) {
      failure = error;
    }
    await this.manager.flushAsync();
    const latest = this.session.messages.findLast((message) => message.role === "assistant"),
      last = this.turns === 0 || latest === priorAssistant ? undefined : latest,
      reason = last?.role === "assistant" ? last.stopReason : null;
    const error =
      failure ??
      this.limit ??
      (this.interrupted || this.controller.signal.aborted
        ? new Error("Query interrupted")
        : last?.role === "assistant" && ["error", "aborted"].includes(last.stopReason)
          ? new Error(last.errorMessage ?? last.stopReason)
          : undefined);
    const base = {
      type: "result" as const,
      uuid: randomUUID(),
      session_id: this.session.sessionId,
      duration_ms: Date.now() - start,
      duration_api_ms: Math.max(0, (this.session.modelPerformance.llmMs ?? 0) - apiStart),
      num_turns: this.turns,
      total_cost_usd: this.totalCost,
      usage: this.totalUsage,
      modelUsage: this.modelUsage,
      permission_denials: [...this.denials],
      stop_reason:
        reason === "stop"
          ? "end_turn"
          : reason === "toolUse"
            ? "tool_use"
            : reason === "length"
              ? "max_tokens"
              : reason,
    };
    this.push(
      error
        ? {
            ...base,
            subtype: this.limit ?? "error_during_execution",
            is_error: true,
            errors: [error instanceof Error ? error.message : String(error)],
          }
        : {
            ...base,
            subtype: "success",
            is_error: false,
            result: last ? messageText(last) : "",
            ...(this.options.outputFormat ? { structured_output: structured } : {}),
          },
    );
  }
  next(): Promise<IteratorResult<SDKMessage, void>> {
    const next = this.requests.then(() => this.takeNext());
    this.requests = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private async takeNext(): Promise<IteratorResult<SDKMessage, void>> {
    if (this.closed) return { value: undefined, done: true };
    this.producing ??= this.produce();
    while (!this.output.length && !this.done)
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    if (this.output.length) return { value: this.output.shift() as SDKMessage, done: false };
    if (this.error) {
      const error = this.error;
      this.error = undefined;
      throw error;
    }
    return { value: undefined, done: true };
  }
  async return(): Promise<IteratorResult<SDKMessage, void>> {
    this.close();
    await this.producing;
    return { value: undefined, done: true };
  }
  async throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>> {
    await this.return();
    throw error;
  }
  [Symbol.asyncIterator](): Query {
    return this;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.return();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.output.splice(0);
    this.controller.abort();
    void this.session?.abort();
    if (this.initialized && !this.producing) this.producing = this.produce();
    else if (!this.producing) {
      this.done = true;
      this.controller.signal.removeEventListener("abort", this.abortListener);
    }
    this.wake?.();
  }
  async interrupt(): Promise<undefined> {
    this.interrupted = true;
    await this.session?.abort();
    return undefined;
  }
  async setModel(model?: string): Promise<void> {
    await this.initialize();
    if (this.runtime && this.session) await this.session.setModel(await selectModel(this.runtime, model));
  }
  async setMaxThinkingTokens(tokens: number | null): Promise<void> {
    if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0))
      throw new Error("Invalid maxThinkingTokens");
    this.options.maxThinkingTokens = tokens ?? undefined;
    this.options.thinking =
      tokens === 0 ? { type: "disabled" } : { type: "enabled", budgetTokens: tokens ?? undefined };
    await this.initialize();
    this.session?.setThinkingLevel(
      tokens === 0
        ? "off"
        : thinkingLevel({
            ...this.options,
            thinking: { type: "enabled", budgetTokens: tokens ?? undefined },
          }),
    );
  }
  async supportedCommands() {
    await this.initialize();
    return (this.session?.listCommands() ?? []).map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: "",
    }));
  }
  async supportedModels() {
    await this.initialize();
    return ((await this.runtime?.getAvailable()) ?? []).map((model) => ({
      value: `${model.provider}/${model.id}`,
      displayName: model.name ?? model.id,
      description: model.provider,
      supportsEffort: model.reasoning,
    }));
  }
  async supportedAgents() {
    await this.initialize();
    return Object.entries(this.options.agents ?? {}).map(([name, agent]) => ({
      name,
      description: agent.description,
      model: agent.model,
    }));
  }
  async initializationResult(): Promise<SDKControlInitializeResponse> {
    await this.initialize();
    return {
      commands: await this.supportedCommands(),
      models: await this.supportedModels(),
      agents: await this.supportedAgents(),
      account: { apiKeySource: this.options.zpi?.modelRuntime ? "user" : "env" },
    };
  }
  async rewindFiles(id: string, options: { dryRun?: boolean } = {}) {
    await this.initialize();
    if (!this.options.enableFileCheckpointing || !this.manager)
      return { canRewind: false, error: "enableFileCheckpointing is required" };
    if (!this.session?.isIdle)
      return { canRewind: false, error: "Interrupt the query before rewinding files" };
    return rewindFiles(this.manager, id, options.dryRun);
  }
}
