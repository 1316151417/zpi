import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync as rmSyncFile, statSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { isJsonObject } from "zpi-ai";
import {
  type AgentSession,
  buildSystemPrompt,
  contextUsage,
  createAgentSession,
  createCodingTools,
  type FileChange,
  FileResourceLoader,
  ModelRuntime,
  type PromptTemplate,
  parseInput,
  parseMentions,
  piTemplate,
  type SessionEntry,
  SessionManager,
  supportedThinkingLevels,
  validateTemplate,
} from "zpi-coding-agent";
import type { DesktopEvent, DesktopEventEnvelope, InputQueue, RunStatus, SessionView } from "zpi-ui";
import { reduceSession, sessionViewBytes } from "zpi-ui/projection";
import { parseSelectionPrompt, validSelections } from "zpi-ui/selections";
import type {
  CombinedSelection,
  DiffItem,
  EditUserInput,
  EditUserResult,
  ProjectRecord,
  PromptPreview,
  RunInput,
  SessionControls,
  SessionRecord,
  SessionSnapshot,
} from "../shared/bridge.ts";
import { availablePresets, taskPinLimit, toPreset, toThinking } from "../shared/config.ts";
import { AttachmentStore } from "./attachments.ts";
import { desktopSystemRules, withDesktopSystemRules } from "./desktop-prompt.ts";
import { DraftStore } from "./draft-store.ts";
import { copyFileChangeSnapshots, entryFileChange, fileChanges } from "./file-changes.ts";
import { applyFileRewind, planFileRewind } from "./file-rewind.ts";
import { HistoryIndex } from "./history-index.ts";
import { SessionInputQueue } from "./input-queue.ts";
import { projectEvent, restoreView } from "./projection.ts";
import { generateSessionTitle } from "./session-title.ts";
import { atomicJson, resolveModel, type SettingsStore } from "./storage.ts";
import { searchFiles, validatedFile } from "./workspace-files.ts";

interface SessionConfiguration {
  template: PromptTemplate;
  disabledSkillPaths: string[];
}
interface ActiveRun {
  runId: string;
  done: Promise<void>;
  finish: () => void;
  ordinal: number;
  aborted?: boolean;
  session?: AgentSession;
  hasAssistant?: boolean;
}
function validateRunInputText(input: RunInput): void {
  if (
    typeof input.text !== "string" ||
    (!input.text.trim() && !input.attachments?.length && !input.fileReferences?.length) ||
    input.text.length > 100000
  )
    throw new Error("invalid_input: 消息无效");
}

export class SessionHost {
  readonly sessions = new Map<string, AgentSession>();
  readonly activeRuns = new Map<string, ActiveRun>();
  private runtimes = new Map<string, ModelRuntime>();
  private managers = new Map<string, SessionManager>();
  private views = new Map<string, SessionView>();
  private indexes = new Map<string, HistoryIndex>();
  private titleJobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private sequences = new Map<string, number>();
  private cursors = new Map<string, number | null>();
  readonly drafts: DraftStore;
  private records = new Map<string, SessionRecord>();
  private visibleSessionId?: string;
  private projects: ProjectRecord[] = [];
  private dir: string;
  private settings: SettingsStore;
  private listeners = new Set<(event: DesktopEventEnvelope) => void>();
  private blocked = new Map<string, string>();
  private closing = false;
  private deleting = new Set<string>();
  private updating = new Set<string>();
  private resourceDir: string;
  private defaultWorkspace: string;
  readonly attachments: AttachmentStore;
  readonly inputQueue: SessionInputQueue;
  private requestFetch?: typeof fetch;
  private userSkillPaths?: string[];
  private configurations = new Map<string, SessionConfiguration>();
  private searches = new Map<string, AbortController>();
  constructor(
    dir: string,
    settings: SettingsStore,
    resourceDir = join(homedir(), ".zpi", "agent"),
    defaultWorkspace = join(homedir(), "Documents", "ZPI"),
    requestFetch?: typeof fetch,
    userSkillPaths?: string[],
  ) {
    this.dir = dir;
    this.drafts = new DraftStore(join(dir, "drafts"));
    this.userSkillPaths = userSkillPaths;
    this.requestFetch = requestFetch;
    this.attachments = new AttachmentStore(join(dir, "agent", "attachments"));
    this.inputQueue = new SessionInputQueue({
      check: (id) => {
        if (this.record(id).archivedAt != null) throw new Error("busy: 任务已归档，请先恢复");
        if (this.closing || this.deleting.has(id) || this.updating.has(id))
          throw new Error("busy: 会话正在关闭或更新");
        if (this.blocked.has(id)) throw new Error(`storage: ${this.blocked.get(id)}`);
      },
      running: (id) => this.activeRuns.has(id) || this.updating.has(id),
      prepare: async (input) => {
        const record = this.record(input.sessionId);
        if (this.closing || this.deleting.has(input.sessionId)) throw new Error("busy: 会话正在关闭或删除");
        if (this.blocked.has(input.sessionId))
          throw new Error(`storage: ${this.blocked.get(input.sessionId)}`);
        const { references, loaded } = await this.loadInput(input);
        const selection = this.getControls(input.sessionId).selection;
        if (!selection || !this.settings.isSelectionValid(selection))
          throw new Error("configuration: 请重新选择模型");
        const model = this.settings.getModel(selection);
        if (loaded.images.length && !model?.input.includes("image"))
          throw new Error("configuration: 当前模型不支持图片");
        if (!(await stat(this.cwd(record))).isDirectory()) throw new Error("configuration: 工作目录不可用");
        return { text: input.text, fileReferences: references, attachments: loaded.metadata, selection };
      },
      retain: (id, item, retained) =>
        this.attachments.markQueued(
          id,
          item.attachments.map((image) => image.id),
          retained,
        ),
      discard: async (id, item) => {
        await this.attachments.markQueued(
          id,
          item.attachments.map((image) => image.id),
          false,
        );
        for (const image of item.attachments) await this.attachments.remove(id, image.id);
      },
      withdraw: async (id, item) => {
        const draft = this.drafts.get(id);
        if (draft.text.trim() || draft.fileReferences.length || draft.selections?.length)
          throw new Error("invalid_input: 请先发送或清空当前草稿，再编辑队列消息。");
        const parsed = parseSelectionPrompt(item.text);
        if (!validSelections(parsed.selections)) {
          parsed.text = item.text;
          parsed.selections = [];
        }
        this.drafts.save(id, {
          text: parsed.text,
          selections: parsed.selections,
          fileReferences: item.fileReferences,
          selection: [parsed.text.length, parsed.text.length],
          revision: draft.revision + 1,
        });
      },
      start: async (input, item) => {
        if (item) await this.setSessionSelection(input.sessionId, item.selection);
        return this.startRun(input, item?.id);
      },
      stop: async (id) => {
        const run = this.activeRuns.get(id);
        if (run) await this.abortRun({ sessionId: id, runId: run.runId });
      },
      save: (id, queue) =>
        this.meta(id, { type: "custom", customType: "zpi.queue", data: JSON.parse(JSON.stringify(queue)) }),
      publish: (id, queue) => {
        this.getSessionSnapshot(id);
        this.emit(id, "queue", { type: "queue_changed", queue });
      },
    });
    this.resourceDir = resourceDir;
    this.defaultWorkspace = defaultWorkspace;
    this.settings = settings;
    const file = join(dir, "projects.json");
    if (existsSync(file)) {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (
        !Array.isArray(raw) ||
        raw.some(
          (p: unknown) =>
            !isJsonObject(p) ||
            typeof p.id !== "string" ||
            !/^[a-zA-Z0-9_-]+$/.test(p.id) ||
            typeof p.name !== "string" ||
            !p.name.trim() ||
            typeof p.path !== "string" ||
            !isAbsolute(p.path) ||
            typeof p.updatedAt !== "number" ||
            !Number.isFinite(p.updatedAt) ||
            (p.hidden !== undefined && typeof p.hidden !== "boolean"),
        )
      )
        throw new Error("storage: Invalid project records");
      const projects = raw as ProjectRecord[];
      if (
        new Set(projects.map((p) => p.id)).size !== projects.length ||
        new Set(projects.map((p) => p.path)).size !== projects.length
      )
        throw new Error("storage: Duplicate project records");
      this.projects = projects;
    }
  }
  async init(): Promise<void> {
    await this.attachments.cleanUnsent();
    const root = join(this.dir, "agent", "sessions");
    await mkdir(root, { recursive: true });
    for (const partition of await readdir(root, { withFileTypes: true })) {
      if (!partition.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(partition.name)) continue;
      const projectId = partition.name === "_unassigned" ? null : partition.name;
      for (const name of await readdir(join(root, partition.name))) {
        if (!/^[a-zA-Z0-9_-]+\.jsonl$/.test(name)) continue;
        const id = name.slice(0, -6),
          index = new HistoryIndex(join(root, partition.name, name));
        try {
          await index.load();
        } catch (error) {
          const diagnostic = `storage: ${String(error)}`;
          this.records.set(id, { id, projectId, title: "无法读取的会话", updatedAt: 0, diagnostic });
          this.blocked.set(id, diagnostic);
          continue;
        }
        this.indexes.set(id, index);
        const state = index.data.state;
        const info = state.session_info;
        const title = info?.type === "session_info" ? info.name : "新对话";
        const meta = state["zpi.session_meta"];
        let pinnedAt: number | null = null,
          archivedAt: number | null = null;
        let diagnostic = index.data.diagnostic;
        if (meta?.type === "custom" && isJsonObject(meta.data)) {
          if (
            meta.data.projectId !== projectId ||
            (meta.data.pinnedAt !== null && !Number.isFinite(meta.data.pinnedAt))
          )
            diagnostic = "会话归属元数据与存储目录不一致";
          else {
            pinnedAt = meta.data.pinnedAt as number | null;
            archivedAt =
              typeof meta.data.archivedAt === "number" && Number.isFinite(meta.data.archivedAt)
                ? meta.data.archivedAt
                : null;
          }
        }
        const latest = state["zpi.run"];
        const data = latest?.type === "custom" && isJsonObject(latest.data) ? latest.data : undefined;
        const status = data
          ? ((data.phase === "start" ? "interrupted" : data.status) as RunStatus)
          : undefined;
        const updatedAt = Date.parse(latest?.timestamp ?? index.data.header.timestamp);
        const attention = state["zpi.attention"];
        const unreadAt =
          attention?.type === "custom" &&
          isJsonObject(attention.data) &&
          typeof attention.data.unreadAt === "number" &&
          Number.isFinite(attention.data.unreadAt)
            ? attention.data.unreadAt
            : undefined;
        if (this.records.has(id)) throw new Error("storage: Duplicate session IDs");
        this.records.set(id, {
          id,
          projectId,
          title,
          status,
          updatedAt,
          pinnedAt,
          archivedAt,
          unreadAt,
          draft:
            meta?.type === "custom" &&
            isJsonObject(meta.data) &&
            meta.data.draft === true &&
            Object.keys(index.data.runs).length === 0,
          ...(diagnostic ? { diagnostic } : {}),
        });
        const savedQueue = state["zpi.queue"];
        if (
          savedQueue?.type === "custom" &&
          isJsonObject(savedQueue.data) &&
          Array.isArray(savedQueue.data.items)
        )
          this.inputQueue.restore(
            id,
            savedQueue.data as unknown as InputQueue,
            typeof data?.queueItemId === "string" ? data.queueItemId : undefined,
          );
      }
    }
    // Keep the earliest pins when migrating older versions without a pin limit.
    const excessPins = [...this.records.values()]
      .filter((record) => record.pinnedAt != null && record.archivedAt == null)
      .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0))
      .slice(taskPinLimit);
    for (const record of excessPins) this.setSessionPinned(record.id, false);
    // Migrate existing sessions before a user can change global defaults.
    for (const id of this.records.keys()) {
      try {
        this.configuration(id);
        if (!this.indexes.get(id)?.data.state["zpi.title"])
          this.meta(id, { type: "custom", customType: "zpi.title", data: { state: "legacy" } });
      } catch (error) {
        this.blocked.set(id, `storage: ${String(error)}`);
      }
    }
  }
  private defaultConfiguration(): SessionConfiguration {
    return {
      template: structuredClone(this.settings.getTemplate()),
      disabledSkillPaths: [...this.settings.get().disabledSkillPaths],
    };
  }
  private configuration(id: string): SessionConfiguration {
    if (this.blocked.has(id)) throw new Error(this.blocked.get(id));
    const cached = this.configurations.get(id);
    if (cached) return cached;
    if (this.record(id).draft) return this.defaultConfiguration();
    const entry = this.indexes.get(id)?.data.state["zpi.configuration"];
    let config: SessionConfiguration;
    if (entry?.type === "custom") {
      config = entry.data as unknown as SessionConfiguration;
      validateTemplate(config.template);
      if (
        !Array.isArray(config.disabledSkillPaths) ||
        config.disabledSkillPaths.some((p) => typeof p !== "string")
      )
        throw new Error("Invalid session configuration");
    } else {
      config = this.defaultConfiguration();
      this.indexes.get(id)?.append({
        type: "custom",
        customType: "zpi.configuration",
        data: config as unknown as import("zpi-ai").JsonObject,
      });
    }
    const snapshot = structuredClone(config);
    if (snapshot.template.id === piTemplate.id) snapshot.template = structuredClone(piTemplate);
    this.configurations.set(id, snapshot);
    return snapshot;
  }
  subscribe(listener: (event: DesktopEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  listProjects(): ProjectRecord[] {
    return structuredClone(this.projects.filter((p) => !p.hidden));
  }
  async addProject(path: string): Promise<ProjectRecord> {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("invalid_input: 请选目录");
    let p = this.projects.find((p) => p.path === canonical);
    if (p) p = { ...p, hidden: false, updatedAt: Date.now() };
    else p = { id: randomUUID(), name: basename(canonical), path: canonical, updatedAt: Date.now() };
    const next = this.projects.filter((o) => o.id !== p?.id).concat(p);
    atomicJson(join(this.dir, "projects.json"), next);
    this.projects = next;
    return structuredClone(p);
  }
  removeProject(id: string): void {
    const p = this.project(id);
    this.saveProject({ ...p, hidden: true, updatedAt: Date.now() });
    this.settings.updatePreferences({
      collapsedProjectIds: this.settings.get().interface.collapsedProjectIds.filter((value) => value !== id),
    });
  }
  private saveProject(project: ProjectRecord): void {
    const next = this.projects.map((p) => (p.id === project.id ? project : p));
    atomicJson(join(this.dir, "projects.json"), next);
    this.projects = next;
  }
  private name(name: string): string {
    if (typeof name !== "string" || !name.trim() || name.length > 200)
      throw new Error("invalid_input: 名称必须为 1–200 个字符");
    return name.trim();
  }
  private project(id: string): ProjectRecord {
    const p = this.projects.find((p) => p.id === id);
    if (!p) throw new Error("not_found: 项目不存在");
    return p;
  }
  private record(id: string): SessionRecord {
    const r = this.records.get(id);
    if (!r) throw new Error("not_found: 会话不存在");
    return r;
  }
  private path(record: SessionRecord): string {
    return join(this.dir, "agent", "sessions", record.projectId ?? "_unassigned", `${record.id}.jsonl`);
  }
  listSessions(projectId: string): SessionRecord[] {
    this.project(projectId);
    return structuredClone(
      [...this.records.values()]
        .filter((r) => r.projectId === projectId && r.archivedAt == null)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    );
  }
  private cwd(record: SessionRecord): string {
    if (record.diagnostic) throw new Error(`storage: ${record.diagnostic}`);
    return record.projectId === null ? this.defaultWorkspace : this.project(record.projectId).path;
  }
  listRecentSessions(): SessionRecord[] {
    return structuredClone(
      [...this.records.values()]
        .filter((r) => r.archivedAt == null)
        .sort((a, b) => {
          if (a.pinnedAt != null && b.pinnedAt != null) return a.pinnedAt - b.pinnedAt;
          if (a.pinnedAt != null) return -1;
          if (b.pinnedAt != null) return 1;
          return b.updatedAt - a.updatedAt;
        })
        .map((r) => {
          try {
            return { ...r, cwd: this.cwd(r) };
          } catch {
            return r;
          }
        }),
    );
  }
  listArchivedSessions() {
    return structuredClone(
      [...this.records.values()]
        .filter((r) => r.archivedAt != null || r.diagnostic || this.blocked.has(r.id))
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
        .map((r) => ({
          ...r,
          diagnostic: r.diagnostic ?? this.blocked.get(r.id),
          projectName:
            r.projectId === null
              ? "无项目"
              : (this.projects.find((p) => p.id === r.projectId)?.name ?? "原项目"),
        })),
    );
  }
  createSession(projectId: string | null): SessionRecord {
    if (this.closing) throw new Error("busy: 应用正在关闭");
    const cwd = projectId === null ? this.defaultWorkspace : this.project(projectId).path;
    if (projectId === null) mkdirSync(cwd, { recursive: true });
    if (!statSync(cwd).isDirectory()) throw new Error("configuration: 工作目录不可用");
    const manager = SessionManager.create(
      cwd,
      join(this.dir, "agent", "sessions", projectId ?? "_unassigned"),
    );
    const index = HistoryIndex.fresh(manager.getSessionFile() as string);
    this.indexes.set(manager.getSessionId(), index);
    manager.subscribeEntries((entry) => index.ingest(entry));
    try {
      manager.appendSessionInfo("新对话");
      manager.appendCustomEntry("zpi.title", { state: "new" });
      manager.appendCustomEntry("zpi.session_meta", { projectId, pinnedAt: null, draft: true });
      const selected = this.settings.get().lastSelection;
      if (selected && this.settings.isSelectionValid(selected)) {
        manager.appendModelChange(selected.provider, selected.modelId);
        manager.appendThinkingLevelChange(toThinking(selected.reasoning, this.settings.getModel(selected)));
      }
    } catch (error) {
      if (manager.getSessionFile()) rmSyncFile(manager.getSessionFile() as string);
      throw error;
    }
    const record = {
      id: manager.getSessionId(),
      projectId,
      title: "新对话",
      draft: true,
      updatedAt: Date.now(),
      pinnedAt: null,
      cwd,
    };
    this.records.set(record.id, record);
    this.managers.set(record.id, manager);
    index.flush();
    return structuredClone(record);
  }
  activateSession(id: string): SessionRecord {
    const record = this.record(id);
    if (this.closing || this.deleting.has(id)) throw new Error("busy: 任务正在关闭或删除");
    if (record.unreadAt !== undefined) this.saveUnread(id, undefined);
    this.visibleSessionId = id;
    return structuredClone(record);
  }
  private saveUnread(id: string, unreadAt: number | undefined): void {
    this.meta(id, { type: "custom", customType: "zpi.attention", data: { unreadAt: unreadAt ?? null } });
    this.record(id).unreadAt = unreadAt;
  }
  setSessionPinned(id: string, pinned: boolean): SessionRecord {
    if (typeof pinned !== "boolean") throw new Error("invalid_input: 无效置顶操作");
    if (this.closing || this.deleting.has(id) || this.blocked.has(id)) throw new Error("busy: 会话不可修改");
    const record = this.record(id);
    if ((record.pinnedAt != null) !== pinned) {
      if (
        pinned &&
        (record.archivedAt != null ||
          [...this.records.values()].filter((r) => r.pinnedAt != null && r.archivedAt == null).length >=
            taskPinLimit)
      )
        throw new Error("invalid_input: 最多置顶 5 个任务，请先取消其他任务的置顶");
      const pinnedAt = pinned
        ? Math.max(Date.now(), ...[...this.records.values()].map((r) => (r.pinnedAt ?? 0) + 1))
        : null;
      const prior = this.indexes.get(id)?.data.state["zpi.session_meta"];
      this.meta(id, {
        type: "custom",
        customType: "zpi.session_meta",
        data: {
          ...(prior?.type === "custom" && isJsonObject(prior.data) ? prior.data : {}),
          projectId: record.projectId,
          pinnedAt,
        },
      });
      record.pinnedAt = pinnedAt;
    }
    return structuredClone(record);
  }
  async archiveSession(id: string): Promise<void> {
    const record = this.record(id);
    if (this.activeRuns.has(id) || this.updating.has(id)) throw new Error("busy: 请先停止运行");
    await this.inputQueue.archive(id, () => {
      const previous = this.indexes.get(id)?.data.state["zpi.session_meta"];
      const archivedAt = Date.now();
      this.meta(id, {
        type: "custom",
        customType: "zpi.session_meta",
        data: {
          ...(previous?.type === "custom" && isJsonObject(previous.data) ? previous.data : {}),
          projectId: record.projectId,
          pinnedAt: null,
          archivedAt,
        },
      });
      Object.assign(record, { archivedAt, pinnedAt: null });
      if (this.visibleSessionId === id) this.visibleSessionId = undefined;
    });
  }
  restoreSession(id: string): SessionRecord {
    const record = this.record(id);
    if (this.activeRuns.has(id) || this.updating.has(id)) throw new Error("busy: 请先停止运行");
    if (this.closing || this.deleting.has(id)) throw new Error("busy: 任务正在关闭或删除");
    if (record.diagnostic || this.blocked.has(id)) throw new Error("storage: 无法读取的任务只能删除");
    const previous = this.indexes.get(id)?.data.state["zpi.session_meta"];
    if (record.projectId !== null) {
      const project = this.project(record.projectId);
      if (project.hidden) this.saveProject({ ...project, hidden: false });
    }
    this.meta(id, {
      type: "custom",
      customType: "zpi.session_meta",
      data: {
        ...(previous?.type === "custom" && isJsonObject(previous.data) ? previous.data : {}),
        projectId: record.projectId,
        pinnedAt: null,
        archivedAt: null,
      },
    });
    Object.assign(record, { archivedAt: null, pinnedAt: null });
    return structuredClone(record);
  }
  private manager(id: string): SessionManager {
    let m = this.managers.get(id);
    if (!m) {
      const r = this.record(id);
      try {
        m = SessionManager.open(this.path(r));
        if (m.getCwd() !== this.cwd(r)) throw new Error("Session cwd does not match its ownership");
        if (m.getSessionId() !== id) throw new Error("Session id does not match its file name");
      } catch (e) {
        throw new Error(`storage: ${String(e)}`);
      }
      const index = this.indexes.get(id);
      if (index) m.subscribeEntries((entry) => index.ingest(entry));
      this.managers.set(id, m);
    }
    return m;
  }
  getSessionSnapshot(id: string): SessionSnapshot {
    const record = this.record(id),
      index = this.indexes.get(id);
    if (index && (index.data.header.id !== id || index.data.header.cwd !== this.cwd(record)))
      throw new Error("storage: Session ownership mismatch");
    if (!index || index.data.diagnostic)
      throw new Error(index?.data.diagnostic ?? "storage: Missing history index");
    let view = this.views.get(id);
    if (!view) {
      const page = index.page();
      view = { ...restoreView(id, record.title, page.entries), seq: this.sequences.get(id) ?? 0 };
      this.cursors.set(id, page.cursor);
      this.views.set(id, view);
    }
    const controls = this.getControls(id);
    const origin = index.data.state["zpi.fork"];
    const forkOrigin =
      origin?.type === "custom" &&
      isJsonObject(origin.data) &&
      typeof origin.data.parentSessionId === "string" &&
      typeof origin.data.runId === "string"
        ? { sessionId: origin.data.parentSessionId, runId: origin.data.runId }
        : undefined;
    view = { ...view, title: record.title, controls, queue: this.inputQueue.get(id), forkOrigin };
    this.views.delete(id);
    this.views.set(id, view);
    this.trimCaches(id);
    return structuredClone({
      session: { ...record, cwd: this.cwd(record) },
      view,
      seq: view.seq,
      controls,
      historyCursor: this.cursors.get(id) ?? null,
    });
  }
  getHistoryPage(id: string, before: number) {
    const record = this.record(id),
      index = this.indexes.get(id);
    if (!index) throw new Error("not_found: 会话不存在");
    const page = index.page(before);
    return { view: restoreView(id, record.title, page.entries), cursor: page.cursor, calls: page.calls };
  }
  private trimCaches(keep?: string): void {
    let bytes = [...this.views.values()].reduce((n, view) => n + sessionViewBytes(view), 0);
    for (const [id, view] of this.views) {
      if (this.views.size <= 8 && bytes <= 64 * 1024 * 1024) break;
      if (id === keep || this.activeRuns.has(id) || this.updating.has(id)) continue;
      bytes -= sessionViewBytes(view);
      this.views.delete(id);
      this.cursors.delete(id);
      this.sessions.get(id)?.dispose();
      this.sessions.delete(id);
      this.managers.delete(id);
      this.runtimes.delete(id);
    }
  }
  private getControls(id: string): SessionControls {
    const index = this.indexes.get(id);
    if (!index) throw new Error("not_found: 会话不存在");
    const entries = Object.entries(index.data.state)
      .filter(([key]) => key !== "thinking_last")
      .map(([, entry]) => entry);
    const context = SessionManager.inMemory(this.cwd(this.record(id)), { id }, entries).buildSessionContext();
    const saved = index.data.state["zpi.selection"];
    const data = saved?.type === "custom" && isJsonObject(saved.data) ? saved.data : undefined;
    const selection: CombinedSelection | null =
      data &&
      typeof data.provider === "string" &&
      typeof data.modelId === "string" &&
      typeof data.reasoning === "string" &&
      data.reasoning.trim()
        ? {
            provider: data.provider,
            modelId: data.modelId,
            reasoning: data.reasoning as CombinedSelection["reasoning"],
          }
        : context.model
          ? {
              ...context.model,
              reasoning: toPreset(context.thinkingLevel, this.settings.getModel(context.model)),
            }
          : null;
    const model = selection ? this.settings.getModel(selection) : undefined;
    const usageModel = this.activeRuns.get(id)?.session?.model ?? model;
    const presets = model ? availablePresets(model) : [];
    return {
      selection,
      presets,
      selectionValid: Boolean(selection && this.settings.isSelectionValid(selection)),
      model: selection ? { provider: selection.provider, modelId: selection.modelId } : null,
      thinkingLevel: selection ? toThinking(selection.reasoning, model) : context.thinkingLevel,
      lastThinkingLevel:
        index.data.state.thinking_last?.type === "thinking_level_change"
          ? index.data.state.thinking_last.thinkingLevel
          : context.lastThinkingLevel,
      thinkingLevels: model ? supportedThinkingLevels(model) : ["off"],
      usage: usageModel
        ? {
            ...contextUsage(
              entries.filter((e) => e.type !== "model_change"),
              usageModel,
            ),
            averageCacheHitRate:
              index.data.cacheInput > 0 ? index.data.cacheRead / index.data.cacheInput : null,
          }
        : { contextWindow: 0, inputTokens: null, percent: null, timestamp: null, source: "unknown" },
      diagnostics: this.sessions.get(id)?.getResourceDiagnostics() ?? [],
    };
  }
  async listSkills(projectId: string) {
    const loader = new FileResourceLoader({
      cwd: this.project(projectId).path,
      agentDir: this.resourceDir,
      userSkillPaths: this.userSkillPaths,
      isSkillEnabled: (path) => this.settings.isSkillEnabled(path),
    });
    await loader.reload();
    return { ...loader.listSkills(), diagnostics: loader.getDiagnostics() };
  }
  async listSessionSkills(id: string) {
    const loader = this.resourceLoader(id);
    await loader.reload();
    return { ...loader.listSkills(), diagnostics: loader.getDiagnostics() };
  }
  workspaceInfo(id: string | null) {
    const record = id === null ? undefined : this.record(id);
    return {
      cwd: record ? this.cwd(record) : this.defaultWorkspace,
      projectName: record?.projectId ? this.project(record.projectId).name : "ZPI",
      projectId: record?.projectId ?? null,
      home: homedir(),
    };
  }
  private resourceLoader(id: string | null) {
    const config = id ? this.configuration(id) : this.defaultConfiguration();
    return new FileResourceLoader({
      cwd: this.workspaceInfo(id).cwd,
      agentDir: this.resourceDir,
      userSkillPaths: this.userSkillPaths,
      projectResources: id !== null,
      isSkillEnabled: (path) => !config.disabledSkillPaths.includes(path),
    });
  }
  async referencedFile(id: string, path: string) {
    const cwd = this.workspaceInfo(id).cwd;
    return validatedFile(cwd, isAbsolute(path) ? relative(await realpath(cwd), await realpath(path)) : path);
  }
  async searchFiles(id: string, query: string) {
    this.searches.get(id)?.abort();
    const controller = new AbortController();
    this.searches.set(id, controller);
    try {
      return await searchFiles(this.workspaceInfo(id).cwd, query, controller.signal);
    } finally {
      if (this.searches.get(id) === controller) this.searches.delete(id);
    }
  }
  async importImage(id: string, name: string, bytes: Uint8Array) {
    this.record(id);
    if (this.deleting.has(id) || this.closing) throw new Error("busy: 会话正在删除或关闭");
    return this.attachments.import(id, name, bytes);
  }
  async readAttachment(id: string, attachment: string) {
    this.record(id);
    return this.attachments.read(id, attachment);
  }
  async removeAttachment(id: string, attachment: string) {
    this.record(id);
    return this.attachments.remove(id, attachment);
  }
  async previewPrompt(): Promise<PromptPreview> {
    const info = this.workspaceInfo(null);
    const loader = this.resourceLoader(null);
    await loader.reload();
    const options = {
      cwd: info.cwd,
      projectName: "ZPI",
      template: this.settings.getTemplate(),
      tools: createCodingTools(info.cwd),
    };
    return {
      ...info,
      basePrompt: buildSystemPrompt({ ...options, loader }),
      systemRules: desktopSystemRules,
      prompt: buildSystemPrompt({ ...options, loader: withDesktopSystemRules(loader) }),
    };
  }
  listTools() {
    return createCodingTools(this.defaultWorkspace).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      promptSnippet: "promptSnippet" in t ? t.promptSnippet : undefined,
      promptGuidelines: "promptGuidelines" in t ? t.promptGuidelines : undefined,
      enabled: true,
    }));
  }
  async getSkillSettings() {
    const loader = this.resourceLoader(null);
    await loader.reload();
    return {
      skills: loader.listDiscoveredSkills(),
      diagnostics: loader.getDiagnostics(),
      directories: [
        ...(this.userSkillPaths ?? [join(homedir(), ".agents", "skills")]),
        join(this.resourceDir, "skills"),
      ],
    };
  }
  async readSkill(path: string) {
    const skills = await this.getSkillSettings();
    if (!skills.skills.some((s) => s.path === path)) throw new Error("invalid_input: 技能不属于全局目录");
    return readFile(path, "utf8");
  }
  async setSkillEnabled(path: string, enabled: boolean) {
    const skills = await this.getSkillSettings();
    if (!skills.skills.some((s) => s.path === path)) throw new Error("invalid_input: 技能不属于全局目录");
    return this.settings.setSkillEnabled(path, enabled);
  }
  private runChanges(id: string, runId: string): FileChange[] {
    let current = "";
    const changes: FileChange[] = [];
    const index = this.indexes.get(id),
      boundary = index?.data.runs[runId];
    if (!index || !boundary) return changes;
    for (const e of index.read({ start: boundary.start.start, end: boundary.end?.end ?? index.data.size })) {
      if (
        e.type === "custom" &&
        e.customType === "zpi.run" &&
        isJsonObject(e.data) &&
        e.data.phase === "start" &&
        typeof e.data.runId === "string"
      )
        current = e.data.runId;
      const change = current === runId ? entryFileChange(e) : undefined;
      if (change) changes.push(change);
    }
    return changes;
  }
  private recordedChanges(id: string, runId: string | null): FileChange[] {
    this.record(id);
    if (runId) return this.runChanges(id, runId);
    const index = this.indexes.get(id);
    if (!index) throw new Error("not_found: 任务不存在");
    return index.data.fileChanges.flatMap((span) =>
      index.read(span).flatMap((entry) => {
        const change = entryFileChange(entry);
        return change ? [change] : [];
      }),
    );
  }
  private allChanges(id: string, runId: string | null): Promise<DiffItem[]> {
    return fileChanges(
      this.recordedChanges(id, runId),
      join(this.dir, "agent", "tool-output", id),
      runId ? "本轮变更" : "任务变更",
    );
  }
  async getChanges(id: string, runId: string | null): Promise<DiffItem[]> {
    return (await this.allChanges(id, runId)).map((entry) =>
      entry.patch && Buffer.byteLength(entry.patch) > 64 * 1024
        ? { ...entry, patch: undefined, patchAvailable: true }
        : entry,
    );
  }
  async readPatch(id: string, runId: string | null, key: string): Promise<string> {
    const change = (await this.allChanges(id, runId)).find((entry) => entry.id === key);
    if (!change) throw new Error("not_found: 修改记录不存在");
    return change.patch ?? change.reason ?? "";
  }
  async setSessionSelection(id: string, selection: CombinedSelection): Promise<SessionSnapshot> {
    this.record(id);
    if (this.closing || this.deleting.has(id) || this.updating.has(id))
      throw new Error("busy: 此会话正在关闭或更新");
    if (this.blocked.has(id)) throw new Error(`storage: ${this.blocked.get(id)}`);
    if (!selection || !this.settings.isSelectionValid(selection))
      throw new Error("configuration: 模型已删除、关闭或思考程度不可用，请重新选择");
    // Composer selection is independent of the current SDK run's immutable configuration.
    this.meta(id, { type: "custom", customType: "zpi.selection", data: { ...selection } });
    this.settings.rememberSelection(selection);
    this.getSessionSnapshot(id);
    this.emit(id, "controls", { type: "controls_changed", controls: this.getControls(id) });
    return this.getSessionSnapshot(id);
  }

  renameSession(id: string, name: string): SessionRecord {
    const record = this.record(id);
    if (this.closing || this.deleting.has(id)) throw new Error("busy: 任务正在关闭或删除");
    if (this.blocked.has(id)) throw new Error(`storage: ${this.blocked.get(id)}`);
    const title = this.name(name);
    this.meta(id, { type: "session_info", name: title });
    this.meta(id, { type: "custom", customType: "zpi.title", data: { state: "manual" } });
    record.title = title;
    const view = this.views.get(id);
    if (view) this.views.set(id, { ...view, title });
    this.emit(id, "title", { type: "session_changed", title });
    return structuredClone(record);
  }
  async deleteSession(id: string): Promise<void> {
    if (this.activeRuns.has(id) || this.updating.has(id) || this.deleting.has(id))
      throw new Error("busy: 请先停止运行");
    const record = this.record(id);
    this.deleting.add(id);
    this.titleJobs.get(id)?.controller.abort();
    try {
      await this.inputQueue.delete(id);
      await this.attachments.deleteSession(id);
      await rm(join(this.dir, "agent", "tool-output", id), { recursive: true, force: true });
      await rm(`${this.path(record)}.index.json`, { force: true });
      this.drafts.delete(id);
      await rm(this.path(record), { force: true });
      this.sessions.get(id)?.dispose();
      this.sessions.delete(id);
      this.managers.delete(id);
      this.runtimes.delete(id);
      this.records.delete(id);
      if (this.visibleSessionId === id) this.visibleSessionId = undefined;
      this.configurations.delete(id);
      this.views.delete(id);
      this.indexes.delete(id);
      this.cursors.delete(id);
      this.sequences.delete(id);
      this.blocked.delete(id);
    } finally {
      this.deleting.delete(id);
    }
  }
  private emit(id: string, runId: string, event: DesktopEvent): void {
    const view = this.views.get(id);
    if (!view && event.type !== "session_changed") throw new Error("Missing session view");
    const seq = (this.sequences.get(id) ?? view?.seq ?? 0) + 1;
    this.sequences.set(id, seq);
    const envelope = { sessionId: id, runId, seq, event };
    if (view) this.views.set(id, reduceSession(view, envelope));
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(envelope));
      } catch {
        /* Transport subscriber cannot halt the agent. */
      }
    }
  }
  private async loadInput(input: RunInput) {
    const { sessionId: id, text } = input;
    validateRunInputText(input);
    const references = input.fileReferences ?? [];
    if (
      !Array.isArray(references) ||
      references.length > 30 ||
      references.some((p) => typeof p !== "string") ||
      new Set(references).size !== references.length
    )
      throw new Error("invalid_input: 文件引用列表无效");
    for (const path of references) await this.referencedFile(id, path);
    const loaded = await this.attachments.load(id, input.attachments ?? []);
    const parsed = parseInput(text);
    if ((references.length || loaded.images.length) && parsed.kind === "compact")
      throw new Error("invalid_input: 此控制命令不接收图片或文件引用");
    return { references, loaded, parsed };
  }
  submitInput(input: RunInput, disposition?: "keep" | "clear") {
    this.record(input.sessionId);
    return this.inputQueue.submit(input, disposition);
  }
  private runStart(entries: SessionEntry[], runId: string): number {
    const index = entries.findIndex(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "zpi.run" &&
        isJsonObject(entry.data) &&
        entry.data.phase === "start" &&
        entry.data.runId === runId,
    );
    if (index < 0) throw new Error("not_found: 消息已失效，请重新加载任务");
    return index;
  }
  async forkSession(id: string, runId: string): Promise<SessionRecord> {
    const parent = this.record(id);
    if (this.closing || this.deleting.has(id) || this.updating.has(id)) throw new Error("busy: 任务正在更新");
    const entries = this.manager(id).getEntries();
    const start = this.runStart(entries, runId);
    const end = entries.findIndex(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "zpi.run" &&
        isJsonObject(entry.data) &&
        entry.data.phase === "end" &&
        entry.data.runId === runId,
    );
    if (end < 0) throw new Error("busy: 只能分叉已结束的回复");
    const prefix = entries.slice(0, end + 1);
    const turn = restoreView(id, parent.title, entries.slice(start, end + 1)).runs[0];
    if (!turn?.finalAnswerBlockIds.length) throw new Error("invalid_input: 此回复没有可分叉的完整正文");
    const child = this.createSession(parent.projectId);
    try {
      const transcript = prefix.filter(
        (entry) =>
          entry.type !== "session_info" &&
          !(
            entry.type === "custom" &&
            ["zpi.session_meta", "zpi.title", "zpi.queue", "zpi.attention"].includes(entry.customType)
          ),
      );
      const manager = this.manager(child.id);
      manager.replaceEntries(
        await copyFileChangeSnapshots(
          transcript,
          join(this.dir, "agent", "tool-output", id),
          join(this.dir, "agent", "tool-output", child.id),
        ),
      );
      await this.attachments.copyTo(
        id,
        child.id,
        prefix.flatMap((entry) =>
          entry.type === "custom" &&
          entry.customType === "zpi.run" &&
          isJsonObject(entry.data) &&
          Array.isArray(entry.data.attachments)
            ? entry.data.attachments.flatMap((image) =>
                isJsonObject(image) && typeof image.id === "string" ? [image.id] : [],
              )
            : [],
        ),
      );
      manager.appendSessionInfo(`Fork of ${parent.title}`.slice(0, 200));
      manager.appendCustomEntry("zpi.session_meta", {
        projectId: child.projectId,
        pinnedAt: null,
        draft: false,
      });
      manager.appendCustomEntry("zpi.title", { state: "manual" });
      manager.appendCustomEntry("zpi.fork", { parentSessionId: id, runId });
      this.managers.delete(child.id);
      const index = new HistoryIndex(this.path(child));
      await index.load();
      this.indexes.set(child.id, index);
      index.flush();
      Object.assign(this.record(child.id), {
        title: `Fork of ${parent.title}`.slice(0, 200),
        draft: false,
        status: turn.status,
      });
      return structuredClone(this.record(child.id));
    } catch (error) {
      await this.deleteSession(child.id);
      throw error;
    }
  }
  async editUserMessage(id: string, runId: string, input: EditUserInput): Promise<EditUserResult> {
    const record = this.record(id);
    if (this.closing || this.deleting.has(id) || this.updating.has(id) || record.archivedAt != null)
      throw new Error("busy: 任务正在关闭或更新");
    const entries = this.manager(id).getEntries();
    const start = this.runStart(entries, runId);
    if (
      entries
        .slice(start + 1)
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "zpi.run" &&
            isJsonObject(entry.data) &&
            entry.data.phase === "start",
        )
    )
      throw new Error("invalid_input: 只能编辑最新一轮用户消息");
    if (input.workspaceMode !== undefined && !["preserve", "rewind"].includes(input.workspaceMode))
      throw new Error("invalid_input: 文件重置参数无效");
    const { workspaceMode, ...prompt } = input;
    const next: RunInput = { ...prompt, sessionId: id };
    validateRunInputText(next);
    const selection = this.getControls(id).selection;
    if (!selection || !this.settings.isSelectionValid(selection))
      throw new Error("configuration: 请先选择有效模型");
    this.updating.add(id);
    try {
      // Validate before stopping or changing durable history. A failed edit keeps the existing turn.
      const { loaded, parsed } = await this.loadInput(next);
      const configuredModel = this.settings.getModel(selection);
      const context = SessionManager.inMemory(
        this.cwd(record),
        {},
        entries.slice(0, start),
      ).buildSessionContext();
      if (
        parsed.kind !== "compact" &&
        !configuredModel?.input.includes("image") &&
        (loaded.images.length ||
          context.messages.some(
            (message) =>
              message.role === "user" &&
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === "image"),
          ))
      )
        throw new Error("configuration: 当前模型不支持图片，请选择图片模型或移除附件");
      if (!(await stat(this.cwd(record))).isDirectory()) throw new Error("configuration: 工作目录不可用");
      if (parsed.kind === "skill") {
        const loader = this.resourceLoader(id);
        await loader.reload();
        await loader.loadSkill(parsed.name);
      }
      const job = this.titleJobs.get(id);
      job?.controller.abort();
      await job?.done;
      const active = this.activeRuns.get(id);
      if (active) await this.abortRun({ sessionId: id, runId: active.runId });
      if (this.closing) throw new Error("busy: 应用正在关闭");
      const manager = this.manager(id);
      const current = manager.getEntries();
      const boundary = this.runStart(current, runId);
      const remaining = new Set([
        "zpi.session_meta",
        "zpi.title",
        "zpi.selection",
        "zpi.configuration",
        "zpi.queue",
      ]);
      const metadata: SessionEntry[] = [];
      for (let i = current.length - 1; i >= 0 && remaining.size; i--) {
        const entry = current[i];
        if (entry.type === "custom" && remaining.delete(entry.customType)) metadata.push(entry);
      }
      metadata.reverse();
      const title = current.findLast((entry) => entry.type === "session_info");
      if (title) metadata.push(title);
      const prefix = current.slice(0, boundary);
      const prefixIds = new Set(prefix.map((entry) => entry.id));
      const transcript = [...prefix, ...metadata.filter((entry) => !prefixIds.has(entry.id))];
      if (workspaceMode === "rewind") {
        // Shell side effects have no write/edit checkpoints; never present a partial restore as complete.
        if (
          current
            .slice(boundary)
            .some(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "toolResult" &&
                entry.message.toolName === "bash",
            )
        )
          return { conflicts: [{ path: "bash/shell", reason: "bash/shell 修改已忽略", ignored: true }] };
        const plan = await planFileRewind(
          this.recordedChanges(id, runId),
          join(this.dir, "agent", "tool-output", id),
          this.cwd(record),
        );
        const conflicts = applyFileRewind(plan, () => manager.replaceEntries(transcript));
        if (conflicts.length) return { conflicts };
      } else manager.replaceEntries(transcript);
      this.sessions.get(id)?.dispose();
      this.sessions.delete(id);
      this.managers.delete(id);
      this.views.delete(id);
      this.cursors.delete(id);
      const index = new HistoryIndex(this.path(record));
      await index.load();
      this.indexes.set(id, index);
      index.flush();
      const snapshot = this.getSessionSnapshot(id);
      this.emit(id, runId, { type: "history_reset", view: snapshot.view });
      this.updating.delete(id);
      await this.startRun(next);
      return this.getSessionSnapshot(id);
    } finally {
      this.updating.delete(id);
    }
  }
  async editQueuedInput(id: string, itemId: string) {
    this.record(id);
    const item = await this.inputQueue.remove(id, itemId, true);
    return { item, draft: this.drafts.get(id) };
  }
  async startRun(input: RunInput, queueItemId?: string): Promise<{ runId: string }> {
    const { sessionId: id, text } = input;
    const record = this.record(id);
    if (record.archivedAt != null) throw new Error("busy: 任务已归档，请先恢复");
    if (this.closing || this.deleting.has(id)) throw new Error("busy: 应用正在关闭或会话正在删除");
    if (this.activeRuns.has(id) || this.updating.has(id)) throw new Error("busy: 此会话正在运行或更新");
    if (this.blocked.has(id)) throw new Error(`storage: ${this.blocked.get(id)}`);
    validateRunInputText(input);
    const selection = this.getControls(id).selection;
    if (!selection || !this.settings.isSelectionValid(selection))
      throw new Error("configuration: 模型已删除、关闭或思考程度不可用，请重新选择");
    const selected = { provider: selection.provider, modelId: selection.modelId };
    const config = this.settings.snapshot(selected.provider);
    const configuredModel = this.settings.getModel(selected);
    if (!configuredModel) throw new Error("configuration: 所选模型已删除，请选择新模型");
    // Reserve synchronously before any asynchronous SDK initialization.
    let finish!: () => void;
    const run: ActiveRun = {
      runId: randomUUID(),
      done: new Promise<void>((r) => {
        finish = r;
      }),
      finish: () => finish(),
      ordinal: 0,
    };
    this.activeRuns.set(id, run);
    try {
      const manager = this.manager(id);
      const { references, loaded, parsed } = await this.loadInput(input);
      const context = manager.buildSessionContext();
      if (!(await stat(this.cwd(record))).isDirectory()) throw new Error("configuration: 工作目录不可用");
      if (
        parsed.kind !== "compact" &&
        !configuredModel.input.includes("image") &&
        (loaded.images.length ||
          context.messages.some(
            (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((c) => c.type === "image"),
          ))
      )
        throw new Error(
          "configuration: 当前模型不支持图片，请选择图片模型或移除附件；有效历史中的图片也需要图片模型",
        );
      this.getSessionSnapshot(id);
      if (record.draft) this.configurations.set(id, structuredClone(this.defaultConfiguration()));
      const runtime = this.runtimes.get(id) ?? (await ModelRuntime.create({ fetch: this.requestFetch }));
      this.configure(runtime, selected.provider, config);
      this.runtimes.set(id, runtime);
      const model = runtime.getModel(selected.provider, selected.modelId);
      if (!model) throw new Error("configuration: 模型不存在");
      let session = this.sessions.get(id);
      if (!session) {
        session = (
          await createAgentSession({
            cwd: this.cwd(record),
            agentDir: join(this.dir, "agent"),
            resourceLoader: withDesktopSystemRules(this.resourceLoader(id)),
            promptTemplate: () => this.configuration(id).template,
            projectName: () => this.workspaceInfo(id).projectName,
            modelRuntime: runtime,
            model,
            sessionManager: manager,
          })
        ).session;
        this.sessions.set(id, session);
      } else await session.setModel(model);
      if (session.state.thinkingLevel !== toThinking(selection.reasoning, model))
        session.setThinkingLevel(toThinking(selection.reasoning, model));
      run.session = session;
      const inputContext = { images: loaded.images, fileReferences: references };
      const prepared = await session.prepareInput(text, inputContext);
      if (this.closing || run.aborted) throw new Error("busy: 请求已停止或应用正在关闭");
      this.titleFromInput(id, text.trim() || (loaded.images.length ? "图片消息" : references[0]));
      this.settings.rememberSelection(this.getControls(id).selection ?? selection);
      const startedAt = Date.now();
      const modelLabel = `${config.name} / ${model.name}`;
      if (record.draft)
        manager.appendCustomEntry(
          "zpi.configuration",
          this.configuration(id) as unknown as import("zpi-ai").JsonObject,
        );
      manager.appendCustomEntry("zpi.run", {
        phase: "start",
        runId: run.runId,
        text,
        fileReferences: references,
        attachments: loaded.metadata,
        startedAt,
        modelLabel,
        agentBoundaries: true,
        ...(queueItemId ? { queueItemId } : {}),
        modelConfig: {
          baseUrl: config.baseUrl,
          provider: selected.provider,
          modelId: model.id,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
          supportsImages: model.input.includes("image"),
        },
      });
      await this.attachments.markUsed(id, input.attachments === undefined ? [] : input.attachments);
      if (record.draft) {
        const prior = this.indexes.get(id)?.data.state["zpi.session_meta"];
        manager.appendCustomEntry("zpi.session_meta", {
          ...(prior?.type === "custom" && isJsonObject(prior.data) ? prior.data : {}),
          projectId: record.projectId,
          pinnedAt: record.pinnedAt ?? null,
          draft: false,
        });
        record.draft = false;
      }
      record.status = "running";
      record.updatedAt = startedAt;
      this.emit(id, run.runId, {
        type: "started",
        text,
        fileReferences: references,
        attachments: loaded.metadata,
        startedAt,
        modelLabel,
      });
      this.startTitle(
        id,
        text || (references.length ? references.join("\n") : ""),
        loaded.images,
        config,
        model,
      );
      const unsubscribe = session.subscribe((e) => {
        if (e.type === "agent_start" || e.type === "agent_end")
          manager.appendCustomEntry("zpi.agent_call", {
            phase: e.type === "agent_start" ? "start" : "end",
            runId: run.runId,
            ordinal: run.ordinal,
          });
        if (e.type === "command_result")
          manager.appendCustomEntry("zpi.notice", { runId: run.runId, text: e.message });
        if (e.type === "entry_appended" && e.entry.type === "compaction")
          this.emit(id, run.runId, { type: "controls_changed", controls: this.getControls(id) });
        if (e.type === "message_start") {
          run.ordinal++;
          if (e.message.role === "assistant") run.hasAssistant = true;
        }
        const projected = projectEvent(e, `${run.runId}:${run.ordinal}`);
        if (projected) this.emit(id, run.runId, projected);
      });
      void session
        .executeInput(prepared, inputContext)
        .then(
          () => this.settle(id, run),
          (error) => this.settle(id, run, error),
        )
        .finally(unsubscribe);
      return { runId: run.runId };
    } catch (error) {
      if (record.draft) {
        this.configurations.delete(id);
        this.sessions.delete(id);
      }
      if (this.activeRuns.get(id) === run) this.activeRuns.delete(id);
      run.finish();
      throw error;
    }
  }
  private meta(id: string, fields: Parameters<HistoryIndex["append"]>[0]): void {
    const manager = this.managers.get(id);
    if (!manager) this.indexes.get(id)?.append(fields);
    else {
      if (fields.type === "session_info") manager.appendSessionInfo(fields.name);
      else if (fields.type === "model_change") manager.appendModelChange(fields.provider, fields.modelId);
      else if (fields.type === "thinking_level_change")
        manager.appendThinkingLevelChange(fields.thinkingLevel);
      else manager.appendCustomEntry(fields.customType, fields.data);
      this.indexes.get(id)?.flush();
    }
  }
  async getDraft(id: string) {
    this.record(id);
    const draft = this.drafts.get(id),
      warnings: string[] = [];
    for (const path of new Set([...draft.fileReferences, ...parseMentions(draft.text).map((m) => m.path)])) {
      try {
        if (!(await stat(path)).isFile()) throw new Error("not a file");
      } catch {
        warnings.push(`引用已失效，原文已保留：${path}`);
      }
    }
    return { ...draft, warnings };
  }
  saveDraft(id: string, draft: import("./draft-store.ts").TextDraft): void {
    this.record(id);
    if (this.deleting.has(id)) throw new Error("busy: 会话正在删除");
    this.drafts.save(id, draft);
  }
  private titleFromInput(id: string, text: string): void {
    const record = this.record(id),
      state = this.indexes.get(id)?.data.state["zpi.title"];
    if (state?.type !== "custom" || !isJsonObject(state.data) || state.data.state !== "new") return;
    const visible = text.trim().replace(/\s+/g, " ");
    const characters = Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(visible),
      (part) => part.segment,
    );
    const title = characters.length > 10 ? `${characters.slice(0, 10).join("")}…` : visible;
    this.meta(id, { type: "session_info", name: title || "图片消息" });
    record.title = title || "图片消息";
    const view = this.views.get(id);
    if (view) this.views.set(id, { ...view, title: record.title });
  }
  private startTitle(
    id: string,
    text: string,
    images: import("zpi-ai").ImageContent[],
    config: ReturnType<SettingsStore["snapshot"]>,
    model: import("zpi-ai").Model,
  ): void {
    const state = this.indexes.get(id)?.data.state["zpi.title"];
    if (state?.type !== "custom" || !isJsonObject(state.data) || state.data.state !== "new") return;
    this.meta(id, {
      type: "custom",
      customType: "zpi.title",
      data: { state: "pending", provider: model.provider, modelId: model.id },
    });
    const controller = new AbortController();
    const done = (async () => {
      try {
        const runtime = await ModelRuntime.create({ fetch: this.requestFetch });
        this.configure(runtime, model.provider, config);
        const title = await generateSessionTitle(
          runtime,
          structuredClone(model),
          text,
          images,
          controller.signal,
        );
        const latest = this.indexes.get(id)?.data.state["zpi.title"];
        if (
          this.closing ||
          this.deleting.has(id) ||
          !this.records.has(id) ||
          latest?.type !== "custom" ||
          !isJsonObject(latest.data) ||
          latest.data.state !== "pending"
        )
          return;
        this.meta(id, { type: "session_info", name: title });
        this.record(id).title = title;
        this.meta(id, { type: "custom", customType: "zpi.title", data: { state: "generated" } });
        this.emit(id, "title", { type: "session_changed", title });
      } catch {
        const latest = this.indexes.get(id)?.data.state["zpi.title"];
        if (
          this.records.has(id) &&
          !this.deleting.has(id) &&
          latest?.type === "custom" &&
          isJsonObject(latest.data) &&
          latest.data.state === "pending"
        )
          this.meta(id, { type: "custom", customType: "zpi.title", data: { state: "failed" } });
      } finally {
        this.titleJobs.delete(id);
      }
    })();
    this.titleJobs.set(id, { controller, done });
  }
  private configure(
    runtime: ModelRuntime,
    providerId: string,
    config = this.settings.snapshot(providerId),
  ): void {
    runtime.clearProviders();
    runtime.registerProvider(providerId, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      ...(config.preset === "openai-chatgpt"
        ? { getApiKey: () => this.settings.getRequestApiKey(providerId, this.requestFetch) }
        : {}),
      models: config.models
        .filter((m) => m.enabled !== false)
        .map((m) => {
          const { provider: _provider, baseUrl: _url, ...model } = resolveModel(config, m);
          return model;
        }),
    });
  }
  private settle(id: string, run: ActiveRun, error?: unknown): void {
    if (this.activeRuns.get(id) !== run) return;
    let status: Exclude<RunStatus, "running"> = "completed";
    let message = error instanceof Error ? error.message : error ? String(error) : undefined;
    const last = run.hasAssistant
      ? run.session?.messages.filter((m) => m.role === "assistant").at(-1)
      : undefined;
    if (message) status = "error";
    else if (last?.stopReason === "error") {
      status = "error";
      message = last.errorMessage;
    } else if (last?.stopReason === "aborted" || run.aborted) status = "aborted";
    const endedAt = Date.now();
    try {
      this.manager(id).appendCustomEntry("zpi.run", {
        phase: "end",
        runId: run.runId,
        status,
        endedAt,
        ...(message ? { error: message } : {}),
      });
      // Mark completed or failed runs unread only when their session is not being viewed.
      if ((status === "completed" || status === "error") && this.visibleSessionId !== id)
        this.saveUnread(id, endedAt);
    } catch (e) {
      status = "error";
      message = `storage: ${e instanceof Error ? e.message : String(e)}`;
      this.blocked.set(id, message);
    }
    if (message?.includes("storage:")) this.blocked.set(id, message);
    this.activeRuns.delete(id);
    const record = this.record(id);
    record.status = status;
    record.updatedAt = endedAt;
    this.emit(id, run.runId, {
      type: "settled",
      status,
      endedAt,
      error: message,
      unreadAt: record.unreadAt,
    });
    this.emit(id, run.runId, { type: "controls_changed", controls: this.getControls(id) });
    this.indexes.get(id)?.flush();
    this.trimCaches(id);
    run.finish();
    this.inputQueue.settled(id, status);
  }
  async abortRun(input: { sessionId: string; runId: string }): Promise<void> {
    const run = this.activeRuns.get(input.sessionId);
    if (!run || run.runId !== input.runId) throw new Error("not_found: 当前运行不存在");
    run.aborted = true;
    if (run.session) await run.session.abort().catch(() => {});
    await run.done;
  }
  async close(): Promise<void> {
    this.closing = true;
    const queueClose = this.inputQueue.close();
    for (const job of this.titleJobs.values()) job.controller.abort();
    await Promise.allSettled([...this.titleJobs.values()].map((job) => job.done));
    const runs = [...this.activeRuns.values()];
    await Promise.allSettled(
      runs.map(async (r) => {
        r.aborted = true;
        try {
          await r.session?.abort();
        } finally {
          await r.done;
        }
      }),
    );
    for (const s of this.sessions.values()) s.dispose();
    await queueClose;
    for (const index of this.indexes.values()) index.flush();
  }
}
