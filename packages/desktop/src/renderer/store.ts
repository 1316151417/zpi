import { buildMentionMarkdown } from "zpi-coding-agent/input";
import type { DesktopEvent, DesktopEventEnvelope, InputSuggestion, SessionView } from "zpi-ui";
import {
  appendSelection,
  ComposerDraftStore,
  type ConversationSelection,
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
export async function withdrawQueuedInput(id: string, itemId: string) {
  const { item, draft } = unwrap(await window.zpi.editQueuedInput(id, itemId));
  // Main saved the withdrawn text before removing it from the durable queue.
  draftRevisions.set(id, draft.revision);
  return { ...draft, attachments: item.attachments, pending: 0 };
}
drafts.subscribe((id) => {
  const draft = drafts.get(id);
  if (!draft || !draftLoaded.has(id)) return;
  const revision = (draftRevisions.get(id) ?? 0) + 1;
  draftRevisions.set(id, revision);
  draftSaving.add(id);
  void window.zpi
    .saveDraft(id, {
      text: draft.text,
      selections: draft.selections,
      fileReferences: draft.fileReferences,
      selection: draft.selection ?? [draft.text.length, draft.text.length],
      revision,
    })
    .then(unwrap)
    .catch(report)
    .finally(() => {
      if (draftRevisions.get(id) === revision) draftSaving.delete(id);
    });
});
async function loadDraft(id: string): Promise<void> {
  if (draftLoaded.has(id)) return;
  const draft = unwrap(await window.zpi.getDraft(id));
  draftRevisions.set(id, draft.revision);
  if (!drafts.has(id)) drafts.set(id, { ...draft, attachments: [], pending: 0 });
  draftLoaded.add(id);
}
function trimViews(keep?: string): void {
  const state = useStore.getState(),
    views = new Map(state.views);
  let size = [...views.values()].reduce((n, view) => n + sessionViewBytes(view), 0);
  for (const [id, view] of views) {
    if (views.size <= 8 && size <= 64 * 1024 * 1024) break;
    if (
      id === keep ||
      state.sessions.get(id)?.status === "running" ||
      draftSaving.has(id) ||
      drafts.submitting.has(id)
    )
      continue;
    size -= sessionViewBytes(view);
    views.delete(id);
    loadedSessions.delete(id);
  }
  useStore.setState({ views });
}
const loadedSessions = new Set<string>();
const snapshotRequests = new Map<string, Promise<void>>();
const pendingSnapshots = new Map<string, DesktopEventEnvelope[]>();
let queue: DesktopEventEnvelope[] = [];
let frame = 0;
function reduceSessionRecord(record: SessionRecord, event: DesktopEvent): SessionRecord {
  switch (event.type) {
    case "session_changed":
      return { ...record, title: event.title };
    case "started":
      return { ...record, draft: false, status: "running", updatedAt: event.startedAt };
    case "settled":
      return { ...record, status: event.status, updatedAt: event.endedAt, unreadAt: event.unreadAt };
    default:
      return record;
  }
}
function apply(events: DesktopEventEnvelope[]): void {
  const state = useStore.getState(),
    views = new Map(state.views),
    records = new Map(state.sessions);
  let recordsChanged = false;
  for (const e of events) {
    const pending = pendingSnapshots.get(e.sessionId);
    if (pending) {
      pending.push(e);
      continue;
    }
    const view = views.get(e.sessionId);
    if (view) views.set(e.sessionId, reduceSession(view, e));
    const record = records.get(e.sessionId);
    if (record) {
      const next = reduceSessionRecord(record, e.event);
      if (next !== record) {
        recordsChanged = true;
        records.set(e.sessionId, next);
      }
    }
  }
  useStore.setState({ views, ...(recordsChanged ? { sessions: records } : {}) });
}
export function report(error: unknown): void {
  useStore.setState({ error: error instanceof Error ? error.message : String(error) });
}
export function subscribeEvents(): () => void {
  return window.zpi.onEvent((e) => {
    queue.push(e);
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        const batch = queue;
        queue = [];
        apply(batch);
      });
  });
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
    ...commands.map((c) => ({ ...c, insert: `/${c.name} `, group: "命令" as const })),
    ...catalog.skills.map((s) => ({
      name: s.name,
      description: s.description,
      insert: `${buildMentionMarkdown(`$${s.name}`, s.path)} `,
      group: "Skill" as const,
    })),
  ]);
  useStore.setState({ resourceDiagnostics, suggestions });
}
export async function refresh(): Promise<void> {
  const [projects, records, settings] = await Promise.all([
    window.zpi.listProjects().then(unwrap),
    window.zpi.listRecentSessions().then(unwrap),
    window.zpi.getSettings().then(unwrap),
  ]);
  useStore.setState({
    projects,
    sessions: new Map(records.map((r) => [r.id, r])),
    settings,
  });
}
export function accept(snapshot: import("../shared/bridge.ts").SessionSnapshot): void {
  const state = useStore.getState();
  const current = state.views.get(snapshot.session.id);
  if (!current || current.seq <= snapshot.seq) {
    const views = new Map(state.views),
      sessions = new Map(state.sessions),
      cursors = new Map(state.historyCursors);
    views.set(snapshot.session.id, current ? mergeHistory(current, snapshot.view) : snapshot.view);
    sessions.set(snapshot.session.id, snapshot.session);
    if (!cursors.has(snapshot.session.id)) cursors.set(snapshot.session.id, snapshot.historyCursor ?? null);
    useStore.setState({ views, sessions, historyCursors: cursors });
  }
}
export async function selectSession(id: string): Promise<void> {
  localStorage.setItem("zpi.selectedSession", id);
  useStore.setState({ selected: id });
  const active = unwrap(await window.zpi.activateSession(id));
  const sessions = new Map(useStore.getState().sessions);
  const record = sessions.get(id);
  if (record) {
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
      views.delete(id);
      views.set(id, view);
      historyCursors.set(id, cursor);
      let record = snapshot.session;
      for (const e of buffered) if (e.seq > snapshot.seq) record = reduceSessionRecord(record, e.event);
      sessions.set(id, record);
      useStore.setState({ views, sessions, historyCursors });
      trimViews(id);
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
  useStore.setState({ historyLoading: new Set(state.historyLoading).add(id) });
  try {
    const page = unwrap(await window.zpi.getHistoryPage(id, cursor));
    const current = useStore.getState(),
      view = current.views.get(id);
    if (!view) return;
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
const openingDrafts = new Map<string, Promise<void>>();
export async function newSession(
  projectId: string | null = useStore.getState().sessions.get(useStore.getState().selected ?? "")
    ?.projectId ?? null,
): Promise<void> {
  const key = projectId ?? "_unassigned";
  const pending = openingDrafts.get(key);
  if (pending) return pending;
  const open = (async () => {
    const draft = [...useStore.getState().sessions.values()]
      .filter((record) => record.draft && record.projectId === projectId && record.archivedAt == null)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const record = draft ?? unwrap(await window.zpi.createSession(projectId));
    if (!draft) await refresh();
    await selectSession(record.id);
  })();
  openingDrafts.set(key, open);
  try {
    await open;
  } finally {
    openingDrafts.delete(key);
  }
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
  } catch (error) {
    drafts.set(sessionId, { ...draft, error: error instanceof Error ? error.message : String(error) });
  }
}
export function resetSession(snapshot: import("../shared/bridge.ts").SessionSnapshot): void {
  const state = useStore.getState();
  const views = new Map(state.views),
    sessions = new Map(state.sessions),
    cursors = new Map(state.historyCursors);
  const current = views.get(snapshot.session.id);
  // Newer events already passed history_reset in sequence; keep their streamed content.
  if (!current || current.seq <= snapshot.seq) {
    views.set(snapshot.session.id, snapshot.view);
    sessions.set(snapshot.session.id, snapshot.session);
  }
  cursors.set(snapshot.session.id, snapshot.historyCursor ?? null);
  useStore.setState({ views, sessions, historyCursors: cursors });
}
