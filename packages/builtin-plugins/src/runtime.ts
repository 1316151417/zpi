import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isJsonObject } from "@zpi-dev/ai";
import type { AgentSessionEvent, PluginSnapshot, ResourceLoader } from "@zpi-dev/coding-agent";
import {
  type BuiltinPluginBindings,
  collaborationEnabled,
  type PluginContext,
  pluginsForSubagent,
  resolveBuiltinPlugins,
  validateBuiltinPluginSnapshots,
} from "./assembly.ts";
import { BackgroundTasks } from "./background/tasks.ts";
import { CollaborationInbox } from "./collaboration/inbox.ts";
import { SubagentProfiles } from "./collaboration/profiles.ts";
import { SubagentPlugin } from "./collaboration/runtime.ts";
import { type SubagentProfile, type SubagentSummary, summarizeSubagent } from "./collaboration/types.ts";
import { desktopPluginIds, enabledBuiltinPlugins } from "./index.ts";
import { LongMemoryService, type LongMemoryState } from "./memory/long-memory.ts";
import { MemoryPolicy } from "./memory/policy.ts";
import { readShortMemory } from "./memory/short-memory.ts";
import { memorySources } from "./memory/sources.ts";
import type { MemoryStatus, SessionMemorySnapshot } from "./memory/types.ts";
import { NotificationsPlugin } from "./notifications.ts";
import type {
  BuiltinPluginPorts,
  PluginConfiguration,
  PluginInput,
  PluginRun,
  PluginRuntimeState,
} from "./ports.ts";
import { UserQuestions } from "./questions.ts";
import { SdkTaskControl } from "./tasks/sdk-control.ts";
import { TitlePolicy } from "./title/policy.ts";
import type { BackgroundTask, SubagentTask } from "./types.ts";
import { WebTools } from "./web/tools.ts";

export type { BuiltinPluginPorts, PluginConfiguration, PluginRun } from "./ports.ts";
export interface SessionBuiltinResources {
  agents: SubagentSummary[];
  memory: SessionMemorySnapshot;
  diagnostics: { path: string; message: string }[];
}

interface Continuation {
  input: PluginInput;
  childAgentId?: string;
}

/** One owner for builtin policies, tool services, recovery and shutdown. */
export class BuiltinPluginRuntime {
  readonly memory: MemoryPolicy;
  readonly longMemory: LongMemoryService;
  readonly titles: TitlePolicy;
  readonly notifications: NotificationsPlugin;
  readonly questions: UserQuestions;
  readonly background: BackgroundTasks;
  readonly collaboration: SubagentPlugin;
  readonly inbox: CollaborationInbox;
  readonly taskControl: SdkTaskControl;
  private readonly parentInstructions = new Map<string, string[]>();
  private readonly web: WebTools;
  private readonly ports: BuiltinPluginPorts;

  constructor(ports: BuiltinPluginPorts) {
    this.ports = ports;
    const sessions = ports.sessions;
    this.longMemory = new LongMemoryService({
      directory: join(ports.directory, "memories_v2"),
      getState: () => ports.storage.getSetting<LongMemoryState>("memory.state"),
      setState: (value) => ports.storage.setSetting("memory.state", value),
      sources: async () =>
        memorySources({
          directory: ports.directory,
          records: () => sessions.records(),
          index: (id) => sessions.history(id),
          cwd: (record) => sessions.cwd(record.id),
          blocked: (id) => sessions.blocked(id),
          active: (id) => sessions.changing(id),
          exists: (id) => !!sessions.get(id),
          deleting: (id) => sessions.deleting(id),
        }),
      run: (request) => this.memory.run(request),
    });
    this.longMemory.configure(ports.memorySettings());
    this.memory = new MemoryPolicy({
      settings: ports.memorySettings,
      selection: (id) => ports.models.selection(id),
      model: (selection) => ports.models.create(selection),
      closing: ports.closing,
      error: (error) => ports.error("memory.check", error),
      homeDir: ports.homeDirectory,
      longMemory: this.longMemory,
      context: (id) => {
        const record = sessions.get(id);
        const config = sessions.configuration(id);
        return {
          cwd: sessions.cwd(id),
          workspace: record?.projectId ? sessions.cwd(id) : undefined,
          child: !!config.subagentProfile,
          memoryInstructions: config.memoryInstructions,
        };
      },
    });
    this.titles = new TitlePolicy({
      state: (id) => sessions.state(id),
      save: (id, patch) => sessions.update(id, patch),
      changed: ports.titleChanged,
      alive: (id) => !ports.closing() && !sessions.deleting(id) && !!sessions.get(id),
      error: (error, id, model) =>
        ports.error("session.title", error, { sessionId: id, provider: model.provider, model: model.id }),
    });
    this.notifications = new NotificationsPlugin(ports);
    this.questions = new UserQuestions((id, question) =>
      ports.publish(id, "questions", { type: "question_changed", question }),
    );
    this.web = new WebTools({ getApiKey: () => ports.credentials("webSearch"), requestFetch: ports.fetch });
    this.inbox = new CollaborationInbox(ports, (id) => !!this.collaboration.taskForChild(id));
    this.background = new BackgroundTasks(ports.directory, {
      publish: (task) => {
        if (!sessions.get(task.sessionId)) return;
        this.taskControl?.publish(task);
        ports.storage.setRuntime(task.sessionId, "background", task.taskId, task, task.status);
        ports.publish(task.sessionId, "background", { type: "background_task_changed", task });
        const parentId = sessions.get(task.sessionId)?.parentSessionId;
        if (parentId && this.collaboration.taskForChild(task.sessionId))
          ports.publish(parentId, "background", { type: "background_task_changed", task });
      },
      notify: async (task) => {
        const active = sessions.active(task.sessionId);
        if (active?.aborted) await active.done;
        if (ports.closing() || !sessions.get(task.sessionId) || sessions.closed(task.sessionId)) return;
        const child = this.collaboration.taskForChild(task.sessionId);
        if (child && child.status !== "running") return;
        await this.inbox.deliver(
          {
            parentSessionId: task.sessionId,
            agentId: task.taskId,
            agentType: "bash",
            description: task.description,
            status: task.status === "completed" ? "completed" : "error",
            result: `Background command ${task.status}. Exit code: ${task.exitCode ?? "unknown"}.\nOutput file: ${task.outputPath}\nUse TaskOutput with task_id ${task.taskId} if the output is needed.`,
          },
          undefined,
          true,
        );
      },
      error: (error) => ports.error("background.task", error),
    });
    this.collaboration = new SubagentPlugin(
      new SubagentProfiles(ports.directory, ports.storage),
      {
        cwd: (id) => sessions.cwd(id),
        selection: (id) => {
          const selection = ports.models.selection(id);
          if (!selection) throw new Error("configuration: 请先选择模型");
          return selection;
        },
        create: async (id, profile, selection, description) => {
          if (!ports.models.valid(selection))
            throw new Error("configuration: 子智能体模型不可用，请在设置中重新选择");
          if (sessions.closed(id) || sessions.active(id)?.aborted)
            throw new Error("busy: 父会话已停止或关闭");
          const child = await sessions.createChild(id);
          try {
            const parent = sessions.configuration(id);
            sessions.configure(child, {
              ...structuredClone(parent),
              plugins: pluginsForSubagent(parent.plugins),
              subagentProfile: structuredClone(profile),
              subagentInstructions: structuredClone(this.parentInstructions.get(id) ?? []),
              ...this.memory.inherit(id),
            });
            sessions.select(child, selection);
            sessions.update(child, { titleState: "manual", title: description, draft: false });
            return child;
          } catch (error) {
            await sessions.delete(child);
            throw error;
          }
        },
        run: async (id, prompt) => {
          if (sessions.get(id)?.archivedAt != null) throw new Error("busy: 子智能体已归档");
          await sessions.run({ sessionId: id, text: prompt }, true);
          while (sessions.active(id)) await sessions.active(id)?.done;
        },
        stop: async (id) => {
          if (sessions.active(id)) await sessions.stop(id);
          else await this.background.stopAll(id);
        },
        steer: (id, text) => this.inbox.guidance(id, text),
        publish: (task) => {
          if (!sessions.get(task.childSessionId) || !sessions.get(task.parentSessionId)) return;
          this.taskControl?.publish(task);
          ports.storage.setRuntime(task.childSessionId, "subagent", task.agentId, task, task.status);
          ports.publish(task.parentSessionId, "subagents", {
            type: "subagent_changed",
            task: structuredClone(task),
          });
        },
        notify: (task, message) => this.inbox.deliver(task, message),
      },
      join(ports.directory, "agent", "subagents"),
    );
    this.taskControl = new SdkTaskControl(
      [this.background.taskBackend(), this.collaboration.taskBackend()],
      (id) => [...this.background.list(id), ...this.collaboration.list(id)],
    );
  }

  snapshots(settings: Parameters<typeof enabledBuiltinPlugins>[0]): PluginSnapshot[] {
    return enabledBuiltinPlugins(settings).filter((plugin) => {
      if (plugin.id !== desktopPluginIds.web) return true;
      try {
        return !!this.ports.credentials("webSearch");
      } catch {
        return false;
      }
    });
  }
  validate(snapshots: readonly PluginSnapshot[], external?: (snapshot: PluginSnapshot) => void): void {
    validateBuiltinPluginSnapshots(snapshots, external);
  }
  private questionTool(id: string) {
    const parentId = this.ports.sessions.configuration(id).subagentProfile
      ? this.ports.sessions.get(id)?.parentSessionId
      : undefined;
    const tool = this.questions.tool(parentId ?? id);
    if (!parentId) return tool;
    return {
      ...tool,
      execute: async (...args: Parameters<typeof tool.execute>) => {
        const task = this.collaboration.taskForChild(id);
        if (task) this.collaboration.update(task.agentId, { waitingForInput: true });
        try {
          return await tool.execute(...args);
        } finally {
          if (task) this.collaboration.update(task.agentId, { waitingForInput: false });
        }
      },
    };
  }

  contributions(
    snapshots: readonly PluginSnapshot[],
    context: PluginContext,
    external: NonNullable<BuiltinPluginBindings["external"]> & { agents(): SubagentProfile[] },
  ) {
    return resolveBuiltinPlugins(snapshots, context, {
      external,
      memory: {
        beginTurn: (id) => this.memory.beginTurn(id),
        instructions: (id) => this.memory.instructions(id),
        read: (id, path) => this.memory.recordRead(id, path),
        schedule: (id) => {
          if (!this.ports.sessions.get(id)?.parentSessionId) this.memory.schedule(id);
        },
      },
      titles: {
        fallback: (id, text) => this.titles.fallback(id, text),
        start: (id) => {
          const input = this.ports.sessions.active(id)?.modelInput;
          if (input) this.titles.start(id, input);
        },
      },
      notifications: this.notifications,
      questionTool: (id) => (context.preview ? this.questions.tool(id) : this.questionTool(id)),
      webTools: () => this.web.tools(),
      background: this.background,
      collaboration: {
        tools: (id, codex) => this.collaboration.tools(id, codex, external.agents),
        childTools: (id) => this.collaboration.childTools(id),
        taskBackend: () => this.collaboration.taskBackend(),
        listing: (id) => this.collaboration.listing(id),
        previewListing: (cwd, codex) => this.collaboration.previewListing(cwd, codex, external.agents()),
      },
    });
  }

  async getMemoryStatus(id: string | null): Promise<MemoryStatus> {
    const record = id ? this.requiredRecord(id) : undefined;
    await this.longMemory.init();
    const short = await readShortMemory({
      homeDir: this.ports.homeDirectory,
      workspace: record?.projectId ? this.ports.sessions.cwd(record.id) : undefined,
    });
    return {
      shortFiles: short.files,
      long: this.longMemory.status(),
      usedSources: id ? this.memory.usedSources(id) : [],
    };
  }
  async checkMemoryNow(id: string | null): Promise<MemoryStatus> {
    if (id) this.requiredRecord(id);
    this.memory.schedule(id);
    return this.getMemoryStatus(id);
  }
  async clearLongMemory(): Promise<MemoryStatus> {
    await this.longMemory.clear();
    await this.memory.wait();
    // 清理共享库只影响新对话；已有会话与冷恢复继续使用持久化的注入内容。
    return this.getMemoryStatus(null);
  }
  async openMemoryFile(
    id: string | null,
    scope: string,
    action: string,
  ): Promise<{ path: string; content: string; exists: boolean }> {
    if (!["user", "project", "long"].includes(scope) || !["view", "edit"].includes(action))
      throw new Error("invalid_input: 记忆文件操作无效");
    const record = id ? this.requiredRecord(id) : undefined;
    if (scope === "project" && !record?.projectId) throw new Error("invalid_input: 当前对话没有项目");
    if (scope === "long" && action === "edit") throw new Error("invalid_input: 长期记忆由后台维护");
    const path =
      scope === "user"
        ? join(this.ports.homeDirectory, ".zpi", "MEMORY.md")
        : scope === "project" && record
          ? join(this.ports.sessions.cwd(record.id), ".zpi", "MEMORY.md")
          : join(this.longMemory.status().path, "memory_summary.md");
    if (action === "edit") {
      await mkdir(join(path, ".."), { recursive: true });
      try {
        await writeFile(path, "# Memory\n", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("invalid_input: 记忆路径必须是普通文件");
      if (scope === "long" || (action === "edit" && info.size > 2 * 1024 * 1024))
        return { path, content: "", exists: true };
      if (info.size > 2 * 1024 * 1024)
        throw new Error("invalid_input: 文件超过 2 MB 预览限制，请使用文件面板或外部编辑器");
      const preview = await this.ports.files.preview(id, path);
      if (preview.kind !== "text") throw new Error("invalid_input: 记忆文件必须是可读文本");
      return { path, content: preview.text ?? "", exists: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, content: "", exists: false };
      throw error;
    }
  }
  resourceLoader(
    id: string | null,
    config: PluginConfiguration,
    loader: Required<Omit<ResourceLoader, "immutable">> & ResourceLoader,
  ) {
    return {
      immutable: loader.immutable,
      listSkills: () => loader.listSkills(),
      loadSkill: (name: string) => loader.loadSkill(name),
      getDiagnostics: () => [...loader.getDiagnostics(), ...(id ? this.memory.diagnostics(id) : [])],
      reload: async () => {
        await loader.reload();
        if (id && !config.subagentProfile)
          this.parentInstructions.set(
            id,
            loader.getInstructions().filter((part) => part.startsWith("<project_context")),
          );
      },
      getBaseInstructions: () => config.subagentProfile?.systemPrompt ?? loader.getBaseInstructions(),
      getInstructions: () =>
        loader
          .getInstructions()
          .filter((part) => !config.subagentProfile || !part.startsWith("<project_context")),
    };
  }
  customInstructions(config: PluginConfiguration): string[] {
    return config.subagentProfile?.injectAgentsMd ? [...(config.subagentInstructions ?? [])] : [];
  }
  async captureResources(
    id: string,
    config: PluginConfiguration,
    imported: SubagentProfile[],
  ): Promise<SessionBuiltinResources> {
    const collaboration = config.plugins.find((plugin) => plugin.id === desktopPluginIds.collaboration);
    const catalog = !config.subagentProfile
      ? await this.collaboration.profiles.listAsync(
          this.ports.sessions.cwd(id),
          collaboration?.options?.promptPreset === "codex",
        )
      : { agents: [], diagnostics: [] };
    const agents = [
      ...new Map(
        [...catalog.agents, ...imported].map((agent) => [agent.name, summarizeSubagent(agent)]),
      ).values(),
    ];
    const mode =
      config.plugins.find((plugin) => plugin.id === desktopPluginIds.memory)?.options?.mode ?? "off";
    await this.memory.capture(id, mode as import("./memory/policy.ts").MemoryMode);
    return { agents, memory: this.memory.snapshot(id), diagnostics: catalog.diagnostics };
  }
  restoreResources(id: string, resources?: SessionBuiltinResources): void {
    // Missing legacy configuration must not trigger discovery in later prompt hooks.
    this.collaboration.restoreCatalog(id, resources?.agents ?? []);
    this.memory.restore(id, resources?.memory);
  }
  observe(id: string, run: PluginRun, e: AgentSessionEvent): void {
    if (e.type === "agent_start") this.inbox.offer(id, run);
    if (e.type === "tool_execution_start" || e.type === "tool_execution_end") this.inbox.offer(id, run, true);
    if (e.type === "message_end" && e.message.role === "user")
      this.inbox.acknowledge(id, e.message.content, e.message.inputId);
    const childTask = this.collaboration.taskForChild(id);
    if (childTask && e.type === "tool_execution_start")
      this.collaboration.update(childTask.agentId, {
        latestActivity: `${e.toolName} · ${isJsonObject(e.args) ? String(e.args.path ?? e.args.command ?? "").slice(0, 500) : ""}`,
        totalToolUseCount: childTask.totalToolUseCount + 1,
      });
    if (childTask && e.type === "message_end" && e.message.role === "assistant")
      if (e.message.usageAvailable || e.message.usage.totalTokens > 0) {
        const usage = e.message.usage;
        const delta: Record<string, number> = {
          inputTokens: usage.input,
          outputTokens: usage.output,
          totalTokens: usage.totalTokens,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
          ...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
        };
        this.collaboration.update(childTask.agentId, {
          totalTokens: childTask.totalTokens + usage.totalTokens,
          tokensReported: true,
          usage: Object.fromEntries(
            Object.entries(delta).map(([key, value]) => [key, (childTask.usage?.[key] ?? 0) + value]),
          ),
        });
      }
  }
  settle(
    id: string,
    run: PluginRun,
    output: { status: SubagentTask["status"]; endedAt: number; message?: string; result?: string },
    storageFailure: (error: unknown, source: string) => string,
  ): Continuation | undefined {
    const inbox = this.inbox.followUp(id);
    const continueInbox =
      inbox.length > 0 &&
      !run.aborted &&
      !this.ports.closing() &&
      !this.ports.sessions.deleting(id) &&
      !this.ports.sessions.blocked(id);
    const childTask = this.collaboration.taskForChild(id);
    if (childTask) {
      const result = output.result;
      try {
        this.collaboration.update(childTask.agentId, {
          status: continueInbox ? "running" : output.status,
          endedAt: continueInbox ? undefined : output.endedAt,
          error: output.message,
          result: continueInbox ? undefined : result,
          waitingForInput: false,
        });
      } catch (error) {
        const message = storageFailure(error, "subagent.persist");
        try {
          this.collaboration.update(childTask.agentId, {
            status: "error",
            error: message,
            endedAt: output.endedAt,
          });
        } catch {
          // The in-memory terminal owner was updated before publication failed.
        }
      }
    }
    return continueInbox ? { input: inbox[0], childAgentId: childTask?.agentId } : undefined;
  }
  continueRun(id: string, continuation?: Continuation): void {
    if (!continuation || this.ports.sessions.blocked(id)) return;
    const { input, childAgentId } = continuation;
    this.inbox.acknowledge(id, input.text);
    void this.ports.sessions.run(input, childAgentId !== undefined).catch((error) => {
      this.ports.error("subagent.delivery", error, { sessionId: id });
      if (childAgentId !== undefined)
        this.collaboration.update(childAgentId, {
          status: "error",
          error: String(error),
          endedAt: Date.now(),
        });
    });
  }
  async stopSession(id: string): Promise<void> {
    await Promise.all([
      this.collaboration.stopAll(id),
      ...(this.collaboration.taskForChild(id) ? [this.background.stopAll(id)] : []),
    ]);
  }
  async beforeHistoryChange(id: string): Promise<void> {
    this.titles.cancel(id);
    await this.titles.wait(id);
  }
  async historyChanged(id: string): Promise<void> {
    await this.longMemory.invalidateSource(id);
  }
  async archive(id: string): Promise<void> {
    await this.background.stopAll(id);
  }
  async configure(): Promise<void> {
    await this.memory.configure(this.ports.memorySettings());
  }
  async beforeDelete(id: string): Promise<void> {
    this.titles.cancel(id);
    await this.longMemory.invalidateSource(id);
    await this.background.stopAll(id);
  }
  forget(id: string): void {
    this.collaboration.forgetSession(id);
    this.background.forget(id);
    this.inbox.forget(id);
    this.parentInstructions.delete(id);
    this.memory.forget(id);
  }
  started(id: string, modelLabel: string): void {
    const task = this.collaboration.taskForChild(id);
    if (task) this.collaboration.update(task.agentId, { modelLabel });
  }
  view(id: string) {
    const subagents = this.collaboration.list(id);
    return {
      question: this.questions.get(id),
      subagents,
      backgroundTasks: [
        ...this.background.list(id),
        ...subagents.flatMap((task) => this.background.list(task.childSessionId)),
      ],
    };
  }
  listSubagents(id: string | null, imported: SubagentProfile[]) {
    const catalog = this.collaboration.profiles.list(id ? this.ports.sessions.cwd(id) : undefined);
    return { ...catalog, agents: [...catalog.agents, ...imported] };
  }
  saveSubagent(input: import("./collaboration/types.ts").SaveSubagentInput) {
    if (!input || (input.sessionId !== null && typeof input.sessionId !== "string"))
      throw new Error("invalid_input: 子智能体参数无效");
    if (input.config?.modelSelection && !this.ports.models.valid(input.config.modelSelection))
      throw new Error("configuration: 请为子智能体选择可用模型和推理档位");
    return this.collaboration.profiles.save(
      input.config,
      input.scope,
      input.id,
      input.sessionId ? this.ports.sessions.cwd(input.sessionId) : undefined,
    );
  }
  async closeChild(id: string): Promise<void> {
    const child = this.ports.sessions.configuration(id).subagentProfile;
    const task = child ? this.collaboration.taskForChild(id) : undefined;
    if (task?.status === "running") await this.collaboration.stop(task.parentSessionId, task.agentId);
    if (this.ports.sessions.active(id)) await this.ports.sessions.stop(id);
    if (child) await this.background.stopAll(id);
  }
  async commandSubagents(id: string, imported: () => SubagentProfile[]) {
    const config = this.ports.sessions.configuration(id);
    if (!collaborationEnabled(config.plugins) || config.subagentProfile) return [];
    return (await this.collaboration.currentProfiles(id, false, imported())).filter((agent) => agent.enabled);
  }
  async agentRequest(
    id: string,
    text: string,
    imported: () => SubagentProfile[],
  ): Promise<{ agent: string; prompt?: string } | undefined> {
    const mention = /^@([^\s@/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!mention) return;
    const agents = await this.collaboration.currentProfiles(id, false, imported());
    const declared = agents.find((agent) => agent.name.toLowerCase() === mention[1].toLowerCase());
    if (!declared) return;
    const config = this.ports.sessions.configuration(id);
    if (!collaborationEnabled(config.plugins) || config.subagentProfile || !declared.enabled)
      throw new Error("invalid_input: 此会话未启用该子智能体");
    return { agent: declared.name, prompt: mention[2]?.trim() };
  }
  async agentPrompt(
    id: string,
    request: { agent: string; prompt?: string },
    imported: () => SubagentProfile[],
  ): Promise<string> {
    if (
      !(await this.commandSubagents(id, imported)).some(
        (agent) => agent.name.toLowerCase() === request.agent.toLowerCase(),
      )
    )
      throw new Error("invalid_input: 此会话未启用该子智能体");
    return `Use the Agent tool with subagent_type ${JSON.stringify(request.agent)} for the following user request. Preserve the requested agent's configured permissions and report its result.\n\n${request.prompt || `Use ${request.agent} for this task.`}`;
  }
  async deleteArtifacts(id: string): Promise<void> {
    await rm(join(this.ports.directory, "agent", "subagents", id), { recursive: true, force: true });
  }
  private requiredRecord(id: string) {
    const record = this.ports.sessions.get(id);
    if (!record) throw new Error("not_found: 会话不存在");
    return record;
  }
  restore(id: string, runtime: PluginRuntimeState): void {
    if (runtime.kind === "background") {
      const task = runtime.data as BackgroundTask;
      this.background.restore({ ...task, status: runtime.status === "interrupted" ? "lost" : task.status });
    } else if (runtime.kind === "subagent_inbox") this.inbox.restore(id, runtime.data as PluginInput[]);
    else if (runtime.kind === "subagent") {
      const task = runtime.data as SubagentTask;
      this.collaboration.restore({
        ...task,
        ...(runtime.status === "interrupted"
          ? { status: "interrupted" as const, waitingForInput: false }
          : {}),
      });
    }
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const close of [
      () => this.longMemory.close(),
      () => this.memory.wait(),
      () => this.collaboration.close(),
      () => this.background.close(),
      () => this.titles.close(),
      () => this.notifications.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to close builtin plugin runtimes");
  }
  async drain(): Promise<void> {
    await this.longMemory.drain();
  }
}
