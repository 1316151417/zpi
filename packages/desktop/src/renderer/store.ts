import { buildMentionMarkdown } from "zpi-coding-agent/input";
import type { DesktopEvent, DesktopEventEnvelope, InputSuggestion, SessionView } from "zpi-ui";
import {
  appendSelection,
  ComposerDraftStore,
  type ConversationSelection,
  emptySession,
  mergeHistory,
  reduceSession,
  sessionViewBytes,
} from "zpi-ui";
import { create } from "zustand";
import type {
  DesktopBridge,
  ProjectRecord,
  PublicSettings,
  Result,
  SessionRecord,
} from "../shared/bridge.ts";
import { emptyTaskGroups, type TaskGroupState, taskGroupFor } from "../shared/task-groups.ts";
import { logRendererError } from "./error-log.ts";
import { previewLoader } from "./preview-loader.ts";
import { hasVisibleShortcutBlocker } from "./shortcut-context.ts";
import { readTaskPreferences, taskPreferencesKey } from "./sidebar-task-model.ts";

declare global {
  interface Window {
    zpi: DesktopBridge;
  }
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
interface Store {
  taskGroups: TaskGroupState;
  taskGroupsHydrated: boolean;
  projects: ProjectRecord[];
  sessions: Map<string, SessionRecord>;
  views: Map<string, SessionView>;
  selected?: string;
  settings?: PublicSettings;
  error?: string;
  ready: boolean;
  historyCursors: Map<string, number | null>;
  historyLoading: Set<string>;
  suggestions: Map<string, InputSuggestion[]>;
  resourceDiagnostics: Map<string, { path: string; message: string }[]>;
}
export const useStore = create<Store>(() => ({
  taskGroups: emptyTaskGroups(),
  taskGroupsHydrated: false,
  projects: [],
  sessions: new Map(),
  views: new Map(),
  ready: false,
  historyCursors: new Map(),
  historyLoading: new Set(),
  suggestions: new Map(),
  resourceDiagnostics: new Map(),
}));
export const drafts = new ComposerDraftStore();
const draftRevisions = new Map<string, number>();
const draftLoaded = new Set<string>();
const draftSaving = new Set<string>();
const draftSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const draftSaveRequests = new Map<string, Promise<void>>();
export async function withdrawQueuedInput(id: string, itemId: string) {
  await saveDraft(id);
  const { item, draft } = unwrap(await window.zpi.editQueuedInput(id, itemId));
  // Main saved the withdrawn text before removing it from the durable queue.
  draftRevisions.set(id, draft.revision);
  return { ...draft, attachments: item.attachments, pending: 0 };
}
export function queueActions(id: string) {
  return {
    edit: (itemId: string) => withdrawQueuedInput(id, itemId),
    remove: (itemId: string) => window.zpi.removeQueuedInput(id, itemId).then(unwrap),
    sendNow: (itemId: string) => window.zpi.sendQueuedNow(id, itemId).then(unwrap),
    move: (itemId: string, beforeId: string | null) =>
      window.zpi.moveQueuedInput(id, itemId, beforeId).then(unwrap),
    resume: () => window.zpi.resumeInputQueue(id).then(unwrap),
  };
}
export type QuestionDraft = {
  requestId: string;
  index: number;
  answers: { selected: string[]; custom: string }[];
};
export const questionDrafts = new Map<string, QuestionDraft>();
function retainQuestionDraft(id: string, requestId?: string) {
  if (questionDrafts.get(id)?.requestId !== requestId) questionDrafts.delete(id);
}
drafts.subscribe((id) => {
  const draft = drafts.get(id);
  if (!draft || !draftLoaded.has(id)) return;
  const revision = (draftRevisions.get(id) ?? 0) + 1;
  draftRevisions.set(id, revision);
  draftSaving.add(id);
  clearTimeout(draftSaveTimers.get(id));
  draftSaveTimers.set(
    id,
    setTimeout(() => void saveDraft(id).catch(report), 200),
  );
});
function saveDraft(id: string): Promise<void> {
  if (!draftSaveTimers.has(id)) {
    const pending = draftSaveRequests.get(id);
    if (pending || !draftSaving.has(id)) return pending ?? Promise.resolve();
  }
  clearTimeout(draftSaveTimers.get(id));
  draftSaveTimers.delete(id);
  const draft = drafts.get(id);
  if (!draft) {
    draftSaving.delete(id);
    return Promise.resolve();
  }
  const revision = draftRevisions.get(id) ?? 0;
  const request = window.zpi
    .saveDraft(id, {
      text: draft.text,
      selections: draft.selections,
      fileReferences: draft.fileReferences,
      selection: draft.selection ?? [draft.text.length, draft.text.length],
      revision,
    })
    .then(unwrap)
    .then(() => {
      if (draftRevisions.get(id) === revision) draftSaving.delete(id);
    });
  draftSaveRequests.set(id, request);
  const cleanup = () => {
    if (draftSaveRequests.get(id) === request) draftSaveRequests.delete(id);
  };
  void request.then(cleanup, cleanup);
  return request;
}
async function flushDrafts(): Promise<void> {
  while (draftSaving.size) await Promise.all([...draftSaving].map(saveDraft));
}
export async function loadDraft(id: string): Promise<void> {
  if (draftLoaded.has(id)) return;
  const draft = unwrap(await window.zpi.getDraft(id));
  draftRevisions.set(id, draft.revision);
  if (!drafts.has(id)) drafts.set(id, { ...draft, attachments: [], pending: 0 });
  draftLoaded.add(id);
}
export const retainedSessionViews = new Set<string>();
function trimViews(keep?: string): void {
  const state = useStore.getState(),
    views = new Map(state.views);
  let size = [...views.values()].reduce((n, view) => n + sessionViewBytes(view), 0);
  for (const [id, view] of views) {
    if (views.size <= 8 && size <= 64 * 1024 * 1024) break;
    if (
      id === keep ||
      id === state.selected ||
      retainedSessionViews.has(id) ||
      state.sessions.get(id)?.status === "running" ||
      draftSaving.has(id) ||
      drafts.submitting.has(id)
    )
      continue;
    size -= sessionViewBytes(view);
    views.delete(id);
    historyGenerations.set(id, (historyGenerations.get(id) ?? 0) + 1);
    loadedSessions.delete(id);
  }
  useStore.setState({ views });
}
const loadedSessions = new Set<string>();
const historyGenerations = new Map<string, number>();
const snapshotRequests = new Map<string, Promise<void>>();
const pendingSnapshots = new Map<string, DesktopEventEnvelope[]>();
export async function closeSideChat(id: string): Promise<void> {
  draftLoaded.delete(id);
  clearTimeout(draftSaveTimers.get(id));
  draftSaveTimers.delete(id);
  draftSaving.delete(id);
  await draftSaveRequests.get(id)?.catch(report);
  const result = await window.zpi.closeSideChat(id);
  if (!result.ok && result.error.code !== "not_found") {
    draftLoaded.add(id);
    unwrap(result);
  }
  drafts.delete(id);
  draftRevisions.delete(id);
  retainedSessionViews.delete(id);
  loadedSessions.delete(id);
  questionDrafts.delete(id);
  previewLoader.clear(id);
  const state = useStore.getState();
  const views = new Map(state.views),
    historyCursors = new Map(state.historyCursors),
    historyLoading = new Set(state.historyLoading),
    suggestions = new Map(state.suggestions),
    resourceDiagnostics = new Map(state.resourceDiagnostics);
  for (const cache of [views, historyCursors, historyLoading, suggestions, resourceDiagnostics])
    cache.delete(id);
  useStore.setState({ views, historyCursors, historyLoading, suggestions, resourceDiagnostics });
  trimViews(useStore.getState().selected);
}
let queue: DesktopEventEnvelope[] = [];
let frame = 0;
function reduceSessionRecord(
  record: SessionRecord,
  event: DesktopEvent,
  envelope?: DesktopEventEnvelope,
): SessionRecord {
  if (envelope?.activityAt !== undefined) {
    if ((record.activitySeq ?? 0) >= envelope.seq) return record;
    record = { ...record, updatedAt: envelope.activityAt, activitySeq: envelope.seq };
  }
  switch (event.type) {
    case "environment_changed":
      return { ...record, cwd: event.cwd, newWorktree: event.newWorktree, worktree: event.worktree };
    case "question_changed":
      return {
        ...record,
        pendingQuestion: event.question
          ? { id: event.question.id, autoResolution: event.question.autoResolution }
          : null,
      };
    case "session_changed":
      return { ...record, title: event.title };
    case "started":
      return { ...record, draft: false, status: "running", running: true, updatedAt: event.startedAt };
    case "settled":
      return {
        ...record,
        status: event.status,
        running: false,
        updatedAt: event.endedAt,
        unreadAt: event.unreadAt,
      };
    default:
      return record;
  }
}
function apply(events: DesktopEventEnvelope[]): void {
  const state = useStore.getState();
  let views = state.views,
    records = state.sessions;
  for (const e of events) {
    const pending = pendingSnapshots.get(e.sessionId);
    if (pending) {
      pending.push(e);
      continue;
    }
    const view = views.get(e.sessionId);
    if (!view || e.seq > view.seq) {
      if (e.event.type === "question_changed") retainQuestionDraft(e.sessionId, e.event.question?.id);
      if (e.event.type === "settled") questionDrafts.delete(e.sessionId);
      if (e.event.type === "history_reset") retainQuestionDraft(e.sessionId, e.event.view.question?.id);
    }
    if (view) {
      const next = reduceSession(view, e);
      if (next !== view) {
        if (e.event.type === "history_reset")
          historyGenerations.set(e.sessionId, (historyGenerations.get(e.sessionId) ?? 0) + 1);
        if (views === state.views) views = new Map(views);
        views.set(e.sessionId, next);
      }
    }
    const record = records.get(e.sessionId);
    if (record) {
      const next = reduceSessionRecord(record, e.event, e);
      if (next !== record) {
        if (records === state.sessions) records = new Map(records);
        records.set(e.sessionId, next);
      }
    }
  }
  if (views !== state.views || records !== state.sessions) useStore.setState({ views, sessions: records });
}
export function report(error: unknown): void {
  logRendererError("reported", error);
  useStore.setState({ error: error instanceof Error ? error.message : String(error) });
}
export function subscribeEvents(): () => void {
  const flush = () => void flushDrafts().catch(report);
  const offBeforeQuit = window.zpi.onBeforeQuit(flushDrafts);
  window.addEventListener("beforeunload", flush);
  const visibility = () => {
    if (document.visibilityState === "hidden") flush();
  };
  document.addEventListener("visibilitychange", visibility);
  const off = window.zpi.onEvent((e) => {
    if (e.event.type === "history_reset") previewLoader.clear(e.sessionId);
    queue.push(e);
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        const batch = queue;
        queue = [];
        apply(batch);
      });
  });
  return () => {
    flush();
    offBeforeQuit();
    window.removeEventListener("beforeunload", flush);
    document.removeEventListener("visibilitychange", visibility);
    off();
  };
}
export async function refreshSuggestions(id: string): Promise<void> {
  const [commands, catalog] = await Promise.all([
    window.zpi.listCommands().then(unwrap),
    window.zpi.listSessionSkills(id).then(unwrap),
  ]);
  const state = useStore.getState();
  const resourceDiagnostics = new Map(state.resourceDiagnostics),
    suggestions = new Map(state.suggestions);
  resourceDiagnostics.set(id, catalog.diagnostics);
  suggestions.set(id, [
    ...(state.sessions.get(id)?.parentSessionId
      ? []
      : [
          { name: "side", description: "新建并打开一个辅助对话", insert: "/side ", group: "命令" as const },
          { name: "btw", description: "在辅助对话中提问", insert: "/btw ", group: "命令" as const },
        ]),
    ...commands.map((c) => ({ ...c, insert: `/${c.name} `, group: "命令" as const })),
    ...catalog.skills.map((s) => ({
      name: s.name,
      description: `${s.source === "project" ? "工作区" : s.source === "user" ? "用户" : "附加"} · ${s.description}`,
      insert: `${buildMentionMarkdown(`$${s.name}`, s.path)} `,
      group: "Skill" as const,
    })),
  ]);
  useStore.setState({ resourceDiagnostics, suggestions });
}
let appliedTaskGroupRequest = 0;
export async function refresh(): Promise<void> {
  const groupRequest = appliedTaskGroupRequest;
  const [projects, records, settings, taskGroups] = await Promise.all([
    window.zpi.listProjects().then(unwrap),
    window.zpi.listRecentSessions().then(unwrap),
    window.zpi.getSettings().then(unwrap),
    window.zpi.getTaskGroups().then(unwrap),
  ]);
  const parentIds = new Set(records.map((record) => record.id));
  records.push(
    ...[...useStore.getState().sessions.values()].filter(
      (record) => record.parentSessionId && parentIds.has(record.parentSessionId),
    ),
  );
  useStore.setState({
    taskGroups: groupRequest === appliedTaskGroupRequest ? taskGroups : useStore.getState().taskGroups,
    taskGroupsHydrated: true,
    projects,
    sessions: new Map(
      records.map((record) => {
        const current = useStore.getState().sessions.get(record.id);
        return [
          record.id,
          current && (current.activitySeq ?? 0) > (record.activitySeq ?? 0)
            ? {
                ...record,
                updatedAt: current.updatedAt,
                activitySeq: current.activitySeq,
                status: current.status,
                running: current.running,
              }
            : record,
        ];
      }),
    ),
    settings,
  });
}
export function accept(snapshot: import("../shared/bridge.ts").SessionSnapshot): void {
  const state = useStore.getState();
  const current = state.views.get(snapshot.session.id);
  if (!current || current.seq <= snapshot.seq) {
    retainQuestionDraft(snapshot.session.id, snapshot.view.question?.id);
    const views = new Map(state.views),
      sessions = new Map(state.sessions),
      cursors = new Map(state.historyCursors);
    views.set(snapshot.session.id, current ? mergeHistory(current, snapshot.view) : snapshot.view);
    sessions.set(snapshot.session.id, snapshot.session);
    if (!cursors.has(snapshot.session.id)) cursors.set(snapshot.session.id, snapshot.historyCursor ?? null);
    useStore.setState({ views, sessions, historyCursors: cursors });
    trimViews(snapshot.session.id);
  }
}
const readingSessions = new Set<string>();
export async function markSessionRead(id: string): Promise<void> {
  const unreadAt = useStore.getState().sessions.get(id)?.unreadAt;
  if (unreadAt === undefined || readingSessions.has(id)) return;
  readingSessions.add(id);
  try {
    const active = unwrap(await window.zpi.activateSession(id));
    const sessions = new Map(useStore.getState().sessions);
    const record = sessions.get(id);
    // A later completion must retain its own unread indicator.
    if (record?.unreadAt === unreadAt) {
      sessions.set(id, { ...record, unreadAt: active.unreadAt });
      useStore.setState({ sessions });
    }
  } finally {
    readingSessions.delete(id);
  }
}
let selectionGeneration = 0;
export async function selectSession(id: string): Promise<void> {
  return selectSessionForNavigation(id, ++selectionGeneration);
}
async function selectSessionForNavigation(id: string, generation: number): Promise<void> {
  if (generation !== selectionGeneration) return;
  const previous = useStore.getState().selected;
  if (previous && previous !== id) await saveDraft(previous);
  // 保存草稿期间用户可能已重新选择任务，迟到的导航不能覆盖最新意图。
  if (generation !== selectionGeneration) return;
  localStorage.setItem("zpi.selectedSession", id);
  useStore.setState({ selected: id });
  const unreadAt = useStore.getState().sessions.get(id)?.unreadAt;
  const active = unwrap(await window.zpi.activateSession(id));
  const sessions = new Map(useStore.getState().sessions);
  const record = sessions.get(id);
  if (record && record.unreadAt === unreadAt) {
    sessions.set(id, { ...record, unreadAt: active.unreadAt });
    useStore.setState({ sessions });
  }
  await loadDraft(id);
  if (loadedSessions.has(id)) {
    await refreshSuggestions(id);
    return;
  }
  const existing = snapshotRequests.get(id);
  if (existing) return existing;
  pendingSnapshots.set(id, []);
  const request = (async () => {
    try {
      const snapshot = unwrap(await window.zpi.getSessionSnapshot(id));
      let view = snapshot.view,
        cursor = snapshot.historyCursor ?? null;
      try {
        const reading = JSON.parse(localStorage.getItem(`zpi.reading.${id}`) ?? "null");
        while (
          reading?.following === false &&
          Number.isSafeInteger(reading.cursor) &&
          cursor !== null &&
          cursor > reading.cursor
        ) {
          const page = unwrap(await window.zpi.getHistoryPage(id, cursor));
          view = mergeHistory(page.view, view);
          cursor = page.cursor;
        }
      } catch (error) {
        report(error);
      }

      const queued = queue.filter((e) => e.sessionId === id);
      queue = queue.filter((e) => e.sessionId !== id);
      const buffered = [...(pendingSnapshots.get(id) ?? []), ...queued].sort((a, b) => a.seq - b.seq);
      for (const event of buffered) if (event.seq > snapshot.seq) view = reduceSession(view, event);
      pendingSnapshots.delete(id);
      loadedSessions.add(id);
      const state = useStore.getState();
      const views = new Map(state.views),
        historyCursors = new Map(state.historyCursors),
        sessions = new Map(state.sessions);
      // 权威快照替换视图时，旧生命周期的分页响应必须失效。
      historyGenerations.set(id, (historyGenerations.get(id) ?? 0) + 1);
      views.delete(id);
      views.set(id, view);
      historyCursors.set(id, cursor);
      let record = snapshot.session;
      for (const e of buffered) if (e.seq > snapshot.seq) record = reduceSessionRecord(record, e.event, e);
      sessions.set(id, record);
      retainQuestionDraft(id, view.question?.id);
      useStore.setState({ views, sessions, historyCursors });
      trimViews(id);
    } catch (error) {
      const buffered = [
        ...(pendingSnapshots.get(id) ?? []),
        ...queue.filter((event) => event.sessionId === id),
      ];
      queue = queue.filter((event) => event.sessionId !== id);
      pendingSnapshots.delete(id);
      if (!useStore.getState().views.has(id)) {
        const state = useStore.getState();
        useStore.setState({
          views: new Map(state.views).set(id, emptySession(id, state.sessions.get(id)?.title)),
        });
      }
      apply(buffered.sort((a, b) => a.seq - b.seq));
      throw error;
    } finally {
      pendingSnapshots.delete(id);
      snapshotRequests.delete(id);
    }
  })();
  snapshotRequests.set(id, request);
  await request;
  await refreshSuggestions(id);
}
export async function loadEarlier(id: string): Promise<void> {
  const state = useStore.getState(),
    cursor = state.historyCursors.get(id);
  if (cursor == null || state.historyLoading.has(id)) return;
  const generation = historyGenerations.get(id) ?? 0;
  useStore.setState({ historyLoading: new Set(state.historyLoading).add(id) });
  try {
    const page = unwrap(await window.zpi.getHistoryPage(id, cursor));
    const current = useStore.getState(),
      view = current.views.get(id);
    // 编辑/重试会替换历史；旧分页响应不能把已移除的内容重新合并回来。
    // 流式事件只增加 seq，不改变历史代次，因此仍可正常合并分页。
    if (!view || (historyGenerations.get(id) ?? 0) !== generation) return;
    const views = new Map(current.views),
      cursors = new Map(current.historyCursors);
    views.set(id, mergeHistory(page.view, view));
    cursors.set(id, page.cursor);
    useStore.setState({ views, historyCursors: cursors });
  } finally {
    const loading = new Set(useStore.getState().historyLoading);
    loading.delete(id);
    useStore.setState({ historyLoading: loading });
  }
}
const openingDrafts = new Map<string, Promise<SessionRecord>>();
export function focusComposer(sessionId: string): void {
  requestAnimationFrame(() => {
    const state = useStore.getState();
    const parentId = state.sessions.get(sessionId)?.parentSessionId;
    if (
      state.selected !== (parentId ?? sessionId) ||
      hasVisibleShortcutBlocker(
        'dialog[open], [role="dialog"], [role="menu"], [role="listbox"], .settings-screen',
      )
    )
      return;
    const editor = document.querySelector<HTMLElement>(
      parentId
        ? `[data-side-chat-session="${sessionId}"] .mention-editor[contenteditable=true]`
        : "main .composer-container .mention-editor[contenteditable=true]",
    );
    if (editor && !editor.closest("[hidden]")) editor.focus();
  });
}
export async function newSession(
  projectId: string | null = useStore.getState().sessions.get(useStore.getState().selected ?? "")
    ?.projectId ?? null,
  groupId?: string | null,
): Promise<string | undefined> {
  // 创建去重与导航意图分开；A → B → A 的最后一次点击不能被 A 的在途资源读取吞掉。
  const generation = ++selectionGeneration;
  if (groupId === undefined) {
    let grouped = false;
    try {
      grouped = readTaskPreferences(localStorage.getItem(taskPreferencesKey)).organizeBy === "grouped";
    } catch {}
    const active = useStore.getState().sessions.get(useStore.getState().selected ?? "");
    groupId =
      grouped && active && active.pinnedAt == null && active.archivedAt == null && !active.parentSessionId
        ? taskGroupFor(useStore.getState().taskGroups, active.id)
        : null;
  }
  const targetGroup = groupId;
  const key = `${projectId ?? "_unassigned"}:${targetGroup ?? "root"}`;
  let opening = openingDrafts.get(key);
  if (!opening) {
    opening = (async () => {
      const draft = [...useStore.getState().sessions.values()]
        .filter(
          (record) =>
            record.draft &&
            !record.parentSessionId &&
            record.projectId === projectId &&
            record.archivedAt == null &&
            taskGroupFor(useStore.getState().taskGroups, record.id) === targetGroup,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const record = draft ?? unwrap(await window.zpi.createSession(projectId, targetGroup));
      if (!draft) {
        await refresh();
      }
      return record;
    })();
    openingDrafts.set(key, opening);
    const cleanup = () => {
      if (openingDrafts.get(key) === opening) openingDrafts.delete(key);
    };
    void opening.then(cleanup, cleanup);
  }
  const record = await opening;
  if (generation !== selectionGeneration) return;
  await selectSessionForNavigation(record.id, generation);
  if (generation !== selectionGeneration || useStore.getState().selected !== record.id) return;
  focusComposer(record.id);
  return record.id;
}
export async function archiveSession(id: string): Promise<void> {
  unwrap(await window.zpi.archiveSession(id));
  await refresh();
  if (useStore.getState().selected === id) {
    localStorage.removeItem("zpi.selectedSession");
    useStore.setState({ selected: undefined });
    const next = [...useStore.getState().sessions.values()].find((r) => !r.diagnostic);
    if (next) await selectSession(next.id);
  }
}
export async function initialize(): Promise<void> {
  try {
    await refresh();
    const records = [...useStore.getState().sessions.values()].filter((r) => !r.diagnostic);
    const saved = localStorage.getItem("zpi.selectedSession");
    const first = records.find((r) => r.id === saved) ?? records[0];
    if (first) await selectSession(first.id);
    else await newSession();
  } catch (error) {
    report(error);
  } finally {
    useStore.setState({ ready: true });
  }
}

export function addConversationSelection(
  reference: ConversationSelection,
  sessionId = useStore.getState().selected,
): void {
  if (!sessionId) return;
  const draft = drafts.get(sessionId);
  if (!draft) return;
  try {
    drafts.set(sessionId, {
      ...draft,
      selections: appendSelection(draft.selections ?? [], reference),
      error: undefined,
    });
    focusComposer(sessionId);
  } catch (error) {
    drafts.set(sessionId, { ...draft, error: error instanceof Error ? error.message : String(error) });
  }
}
export function resetSession(snapshot: import("../shared/bridge.ts").SessionSnapshot): void {
  historyGenerations.set(snapshot.session.id, (historyGenerations.get(snapshot.session.id) ?? 0) + 1);
  previewLoader.clear(snapshot.session.id);
  const state = useStore.getState();
  const views = new Map(state.views),
    sessions = new Map(state.sessions),
    cursors = new Map(state.historyCursors);
  const current = views.get(snapshot.session.id);
  // Newer events already passed history_reset in sequence; keep their streamed content.
  if (!current || current.seq <= snapshot.seq) {
    retainQuestionDraft(snapshot.session.id, snapshot.view.question?.id);
    views.set(snapshot.session.id, snapshot.view);
    sessions.set(snapshot.session.id, snapshot.session);
  }
  cursors.set(snapshot.session.id, snapshot.historyCursor ?? null);
  useStore.setState({ views, sessions, historyCursors: cursors });
}

let taskGroupRequest = 0;
export async function changeTaskGroups(
  command: Parameters<DesktopBridge["updateTaskGroups"]>[0],
): Promise<TaskGroupState> {
  const request = ++taskGroupRequest;
  const taskGroups = unwrap(await window.zpi.updateTaskGroups(command));
  if (request > appliedTaskGroupRequest) {
    // 失败写入不能废弃首屏读取；只有成功落地的新状态才阻止旧刷新或旧命令回包覆盖。
    appliedTaskGroupRequest = request;
    useStore.setState({ taskGroups });
  }
  return taskGroups;
}

export async function prepareDiscardDraft(id: string): Promise<void> {
  if (!useStore.getState().sessions.get(id)?.draft) throw new Error("只能关闭未发送的新任务");
  await saveDraft(id);
}
export function forgetDiscardedDraft(id: string): void {
  clearTimeout(draftSaveTimers.get(id));
  draftSaveTimers.delete(id);
  draftSaving.delete(id);
  draftLoaded.delete(id);
  draftRevisions.delete(id);
  drafts.delete(id);
  loadedSessions.delete(id);
  if (useStore.getState().selected === id) {
    useStore.setState({ selected: undefined });
    localStorage.removeItem("zpi.selectedSession");
  }
}
