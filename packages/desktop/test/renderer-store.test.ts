import { afterEach, expect, it, vi } from "vitest";
import type { DesktopEventEnvelope } from "zpi-ui";
import { shallow } from "zustand/shallow";
import { deferred } from "../../../tests/fake-server.ts";
import { selectAppState, selectTaskRecords } from "../src/renderer/app-state.ts";
import type { SessionRecord } from "../src/shared/bridge.ts";
import { emptyTaskGroups } from "../src/shared/task-groups.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup() {
  vi.resetModules();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  let emit!: (event: DesktopEventEnvelope) => void;
  let beforeQuit!: () => Promise<void>;
  const session: SessionRecord = {
    id: "session",
    title: "Task",
    projectId: null,
    createdAt: 0,
    updatedAt: 0,
  };
  const snapshot = {
    session,
    view: { sessionId: session.id, title: session.title, seq: 0, runs: [] },
    seq: 0,
  };
  const bridge = {
    listProjects: vi.fn(async () => ({ ok: true, value: [] })),
    listRecentSessions: vi.fn(async () => ({ ok: true, value: [session] })),
    getTaskGroups: vi.fn(async () => ({ ok: true, value: emptyTaskGroups() })),
    updateTaskGroups: vi.fn(async () => ({ ok: true, value: emptyTaskGroups() })),
    getSettings: vi.fn(async () => ({ ok: true, value: {} })),
    activateSession: vi.fn(async () => ({ ok: true, value: { unreadAt: undefined } })),
    getDraft: vi.fn(async () => ({
      ok: true,
      value: { text: "", fileReferences: [], selection: [0, 0], revision: 0 },
    })),
    saveDraft: vi.fn(async () => ({ ok: true, value: undefined })),
    closeSideChat: vi.fn(async () => ({ ok: true, value: undefined })),
    createSession: vi.fn(async (_projectId: string | null, _groupId?: string | null) => ({
      ok: true,
      value: { ...session, id: "created", draft: true },
    })),
    getSessionSnapshot: vi.fn(async (_id?: string) => ({ ok: true, value: snapshot })),
    listSessionCustomCommands: vi.fn(async () => ({
      ok: true,
      value: { commands: [], diagnostics: [], directoryPath: "/fixture/.zpi/commands", subagents: [] },
    })),
    listCommands: vi.fn(async () => ({
      ok: true,
      value: [] as ReturnType<typeof import("zpi-coding-agent").listCommands>,
    })),
    listSessionSkills: vi.fn(async (_id?: string) => ({ ok: true, value: { skills: [], diagnostics: [] } })),
    onEvent: vi.fn((listener: typeof emit) => {
      emit = listener;
      return () => {};
    }),
    onBeforeQuit: vi.fn((listener: typeof beforeQuit) => {
      beforeQuit = listener;
      return () => {};
    }),
    logError: vi.fn(),
  };
  const window = Object.assign(new EventTarget(), { zpi: bridge });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  const store = await import("../src/renderer/store.ts");
  store.useStore.setState({ sessions: new Map([[session.id, session]]) });
  const unsubscribe = store.subscribeEvents();
  return {
    store,
    bridge,
    snapshot,
    session,
    window,
    document,
    unsubscribe,
    beforeQuit: () => beforeQuit(),
    emit: (event: DesktopEventEnvelope) => emit(event),
    frame: () => {
      for (const callback of frames.splice(0)) callback(0);
    },
  };
}

it("reports friendly error copy while retaining diagnostics and replacing identical notifications", async () => {
  const f = await setup();
  const error = new Error("not_found: 文件不存在：/private/example/missing.md");
  f.store.report(error);
  expect(f.store.useStore.getState().error).toContain("找不到文件");
  expect(f.store.useStore.getState().error).not.toMatch(/not_found|\/private\//);
  expect(f.bridge.logError).toHaveBeenCalledWith(expect.objectContaining({ message: error.message }));
  const version = f.store.useStore.getState().errorVersion;
  f.store.report(error);
  expect(f.store.useStore.getState().errorVersion).toBe(version + 1);
  f.unsubscribe();
});

it("keeps a late input-scoped failure off a draft changed after submit", async () => {
  const f = await setup();
  f.store.useStore.setState({ selected: f.session.id });
  f.store.drafts.set(f.session.id, { text: "old", fileReferences: [], attachments: [], pending: 0 });
  const revision = f.store.drafts.revision(f.session.id);
  f.store.report(new Error("not_found: 文件不存在：/private/missing.md"), {
    input: f.session.id,
    revision,
  });
  expect(f.store.drafts.get(f.session.id)?.error).toContain("找不到文件");
  expect(f.store.useStore.getState().error).toBeUndefined();

  f.store.drafts.set(f.session.id, { text: "new", fileReferences: [], attachments: [], pending: 0 });
  f.store.report(new Error("not_found: 文件不存在：/private/missing.md"), {
    input: f.session.id,
    revision,
  });
  expect(f.store.drafts.get(f.session.id)?.error).toBeUndefined();
  expect(f.store.useStore.getState().error).toBe(
    "上一次发送失败：找不到文件“missing.md”，请确认文件是否已移动或删除。",
  );
  f.unsubscribe();
});

it("lists built-in commands without auxiliary slash shortcuts", async () => {
  const f = await setup();
  const { listCommands } = await import("zpi-coding-agent");
  f.bridge.listCommands.mockResolvedValue({ ok: true, value: listCommands() });
  await f.store.refreshSuggestions(f.session.id);
  const names = f.store.useStore
    .getState()
    .suggestions.get(f.session.id)
    ?.map((item) => item.name);
  expect(names).toContain("init");
  expect(names).toContain("compact");
  expect(names).not.toContain("side");
  expect(names).not.toContain("btw");
  f.unsubscribe();
});

it("opens a manual auxiliary chat once without submitting a prompt", async () => {
  const f = await setup();
  const child = { ...f.session, id: "manual-side", parentSessionId: f.session.id };
  const createSideChat = vi.fn(async () => ({ ok: true, value: child }));
  const submitInput = vi.fn();
  Object.assign(f.bridge, { createSideChat, submitInput });
  f.bridge.getSessionSnapshot.mockResolvedValue({
    ok: true,
    value: { session: child, view: { ...f.snapshot.view, sessionId: child.id }, seq: 0 },
  });
  f.store.useStore.setState({ selected: f.session.id });
  const { openSideChat, usePane } = await import("../src/renderer/pane-store.ts");
  await Promise.all([openSideChat(f.session.id), openSideChat(f.session.id)]);
  expect(createSideChat).toHaveBeenCalledExactlyOnceWith(f.session.id);
  expect(submitInput).not.toHaveBeenCalled();
  expect(usePane.getState()).toMatchObject({
    open: true,
    active: usePane.getState().tabs[0].id,
    tabs: [{ type: "side-chat", sessionId: f.session.id, childSessionId: child.id }],
  });
  expect(f.store.drafts.get(child.id)?.text).toBe("");
  f.unsubscribe();
});

it("side-chat streaming keeps the main app selection stable without losing activity or deltas", async () => {
  const f = await setup();
  const child = { ...f.session, id: "side", parentSessionId: f.session.id };
  f.store.useStore.setState({
    selected: f.session.id,
    sessions: new Map([
      [f.session.id, f.session],
      [child.id, child],
    ]),
    views: new Map([[child.id, { sessionId: child.id, title: "Side", seq: 0, runs: [] }]]),
  });
  const app = selectAppState(f.store.useStore.getState());
  const tasks = selectTaskRecords(f.store.useStore.getState());
  let broadChanges = 0;
  let appChanges = 0;
  const off = f.store.useStore.subscribe((state, previous) => {
    if (state.sessions !== previous.sessions) broadChanges++;
    if (!shallow(selectAppState(state), app) || !shallow(selectTaskRecords(state), tasks)) appChanges++;
  });
  let seq = 0;
  const emit = (event: DesktopEventEnvelope["event"]) => {
    f.emit({ sessionId: child.id, runId: "run", seq: ++seq, activityAt: seq * 10, event });
    f.frame();
  };
  emit({ type: "started", text: "Side question", startedAt: 10, modelLabel: "model" });
  emit({ type: "block_start", messageId: "message", contentIndex: 0, kind: "text" });
  for (let i = 0; i < 100; i++)
    emit({ type: "block_delta", messageId: "message", contentIndex: 0, delta: "x" });
  expect(broadChanges).toBe(102);
  expect(appChanges).toBe(0);
  expect(f.store.useStore.getState().sessions.get(child.id)).toMatchObject({
    updatedAt: 1020,
    activitySeq: 102,
    running: true,
  });
  expect(f.store.useStore.getState().views.get(child.id)?.runs[0].orderedBlocks[0]).toMatchObject({
    text: "x".repeat(100),
  });
  off();
  f.unsubscribe();
});

it("main app selectors retain active streaming, history, task metadata and unread updates", async () => {
  const f = await setup();
  f.store.useStore.setState({
    selected: f.session.id,
    views: new Map([[f.session.id, f.snapshot.view]]),
  });
  const before = selectAppState(f.store.useStore.getState());
  const tasks = selectTaskRecords(f.store.useStore.getState());
  f.emit({
    sessionId: f.session.id,
    runId: "run",
    seq: 1,
    activityAt: 10,
    event: { type: "started", text: "hello", startedAt: 10, modelLabel: "model" },
  });
  f.frame();
  expect(selectAppState(f.store.useStore.getState()).activeView).not.toBe(before.activeView);
  expect(shallow(selectTaskRecords(f.store.useStore.getState()), tasks)).toBe(false);
  f.emit({
    sessionId: f.session.id,
    runId: "run",
    seq: 2,
    activityAt: 20,
    event: { type: "settled", status: "completed", endedAt: 20, unreadAt: 20 },
  });
  f.frame();
  expect(selectAppState(f.store.useStore.getState()).activeRecord).toMatchObject({
    updatedAt: 20,
    unreadAt: 20,
    running: false,
  });
  f.store.useStore.setState({ historyCursors: new Map([["side", 50]]), historyLoading: new Set(["side"]) });
  const selected = selectAppState(f.store.useStore.getState());
  f.store.useStore.setState({ historyCursors: new Map([["side", 10]]), historyLoading: new Set() });
  expect(shallow(selectAppState(f.store.useStore.getState()), selected)).toBe(true);
  f.store.useStore.setState({
    historyCursors: new Map([[f.session.id, 10]]),
    historyLoading: new Set([f.session.id]),
  });
  expect(selectAppState(f.store.useStore.getState())).toMatchObject({
    historyCursor: 10,
    loadingEarlier: true,
  });
  f.unsubscribe();
});

it("ignores replayed and unknown events without replacing maps or notifying subscribers", async () => {
  const f = await setup();
  f.store.useStore.setState({ views: new Map([[f.session.id, f.snapshot.view]]) });
  const event: DesktopEventEnvelope = {
    sessionId: f.session.id,
    runId: "run",
    seq: 1,
    activityAt: 10,
    event: { type: "started", text: "hello", startedAt: 10, modelLabel: "model" },
  };
  f.emit(event);
  f.frame();
  const state = f.store.useStore.getState();
  const changed = vi.fn();
  const off = f.store.useStore.subscribe(changed);
  f.emit(event);
  f.frame();
  f.emit({ ...event, sessionId: "closed" });
  f.frame();
  expect(f.store.useStore.getState()).toBe(state);
  expect(changed).not.toHaveBeenCalled();
  off();
  f.unsubscribe();
});

it("late list snapshots preserve newer activity and running facts while applying metadata", async () => {
  const f = await setup();
  const gate = deferred();
  f.bridge.listRecentSessions.mockImplementationOnce(async () => {
    await gate.promise;
    return {
      ok: true,
      value: [{ ...f.session, title: "renamed", pinnedAt: 500, updatedAt: 10, activitySeq: 1 }],
    };
  });
  const refreshing = f.store.refresh();
  f.emit({
    sessionId: f.session.id,
    runId: "run",
    seq: 2,
    activityAt: 20,
    event: { type: "started", text: "hello", startedAt: 20, modelLabel: "model" },
  });
  f.frame();
  gate.resolve();
  await refreshing;
  expect(f.store.useStore.getState().sessions.get(f.session.id)).toMatchObject({
    title: "renamed",
    pinnedAt: 500,
    updatedAt: 20,
    activitySeq: 2,
    running: true,
  });
  f.emit({
    sessionId: f.session.id,
    runId: "run",
    seq: 1,
    activityAt: 10,
    event: { type: "settled", status: "completed", endedAt: 10 },
  });
  f.frame();
  expect(f.store.useStore.getState().sessions.get(f.session.id)).toMatchObject({
    updatedAt: 20,
    activitySeq: 2,
    running: true,
  });
  f.unsubscribe();
});

it("snapshot failure replays both buffered and pending-frame events and allows a later retry", async () => {
  const f = await setup();
  const gate = deferred();
  f.bridge.getSessionSnapshot.mockImplementationOnce(async () => {
    await gate.promise;
    throw new Error("snapshot unavailable");
  });
  const selecting = f.store.selectSession(f.session.id);
  const rejection = expect(selecting).rejects.toThrow("snapshot unavailable");
  await vi.waitFor(() => expect(f.bridge.getSessionSnapshot).toHaveBeenCalledOnce());
  f.emit({
    sessionId: f.session.id,
    runId: "run",
    seq: 1,
    event: { type: "started", text: "accepted", startedAt: 1, modelLabel: "model" },
  });
  f.frame();
  f.emit({
    sessionId: f.session.id,
    runId: "run",
    seq: 2,
    event: { type: "settled", status: "completed", endedAt: 2 },
  });
  gate.resolve();
  await rejection;
  expect(f.store.useStore.getState().views.get(f.session.id)?.runs[0]).toMatchObject({
    userMessage: "accepted",
    status: "completed",
  });
  expect(f.store.useStore.getState().sessions.get(f.session.id)?.status).toBe("completed");
  await f.store.selectSession(f.session.id);
  expect(f.bridge.getSessionSnapshot).toHaveBeenCalledTimes(2);
  f.unsubscribe();
});

it("keeps the latest task selection when an earlier navigation waits for a draft save", async () => {
  const f = await setup();
  await f.store.selectSession(f.session.id);
  const gate = deferred();
  f.bridge.saveDraft.mockImplementationOnce(async () => {
    await gate.promise;
    return { ok: true, value: undefined };
  });
  const draft = f.store.drafts.get(f.session.id);
  if (!draft) throw new Error("draft missing");
  f.store.drafts.set(f.session.id, { ...draft, text: "unsaved draft" });
  const earlier = f.store.selectSession("other");
  expect(f.bridge.saveDraft).toHaveBeenCalledOnce();
  expect(f.store.useStore.getState().selected).toBe(f.session.id);
  // Clicking the still-selected row is a newer explicit intent, without another save wait.
  await f.store.selectSession(f.session.id);
  gate.resolve();
  await earlier;
  expect(f.store.useStore.getState().selected).toBe(f.session.id);
  expect(localStorage.getItem("zpi.selectedSession")).toBe(f.session.id);
  expect(f.bridge.activateSession).not.toHaveBeenCalledWith("other");
  expect(f.bridge.getSessionSnapshot).toHaveBeenCalledOnce();
  expect(f.store.drafts.get(f.session.id)?.text).toBe("unsaved draft");
  f.unsubscribe();
});

it.each(["scheduled", "in flight"])(
  "quitting waits for %s saves and subsequent draft changes",
  async (mode) => {
    const f = await setup();
    await f.store.selectSession(f.session.id);
    vi.useFakeTimers();
    const gate = deferred();
    f.bridge.saveDraft.mockImplementationOnce(async () => {
      await gate.promise;
      return { ok: true, value: undefined };
    });
    const update = (text: string) => {
      const draft = f.store.drafts.get(f.session.id);
      if (!draft) throw new Error("draft missing");
      f.store.drafts.set(f.session.id, { ...draft, text });
    };
    update("first save");
    if (mode === "in flight") vi.advanceTimersByTime(200);
    let flushed = false;
    const flushing = f.beforeQuit().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(f.bridge.saveDraft).toHaveBeenCalledOnce();
    expect(flushed).toBe(false);
    update("latest draft");
    gate.resolve();
    await flushing;
    expect(f.bridge.saveDraft).toHaveBeenCalledTimes(2);
    expect(f.bridge.saveDraft.mock.calls[1]).toEqual([
      f.session.id,
      expect.objectContaining({ text: "latest draft" }),
    ]);
    f.unsubscribe();
  },
);

it("a failed quit flush keeps the draft dirty so the next attempt can retry", async () => {
  const f = await setup();
  await f.store.selectSession(f.session.id);
  vi.useFakeTimers();
  const draft = f.store.drafts.get(f.session.id);
  if (!draft) throw new Error("draft missing");
  f.store.drafts.set(f.session.id, { ...draft, text: "unsaved draft" });
  f.bridge.saveDraft.mockRejectedValueOnce(new Error("disk full"));
  await expect(f.beforeQuit()).rejects.toThrow("disk full");
  await f.beforeQuit();
  expect(f.bridge.saveDraft).toHaveBeenCalledTimes(2);
  expect(f.bridge.saveDraft.mock.calls[1]).toEqual(f.bridge.saveDraft.mock.calls[0]);
  f.unsubscribe();
});

it("typing batches draft writes and hiding or closing the window flushes the latest text", async () => {
  const f = await setup();
  await f.store.selectSession(f.session.id);
  vi.useFakeTimers();
  const update = (text: string) => {
    const draft = f.store.drafts.get(f.session.id);
    if (!draft) throw new Error("draft missing");
    f.store.drafts.set(f.session.id, { ...draft, text, selection: [text.length, text.length] });
  };
  for (let i = 0; i < 20; i++) update(`typing ${i}`);
  expect(f.bridge.saveDraft).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(f.bridge.saveDraft).toHaveBeenCalledOnce();
  expect(f.bridge.saveDraft.mock.calls[0]).toEqual([
    f.session.id,
    expect.objectContaining({ text: "typing 19" }),
  ]);
  update("hidden draft");
  f.document.visibilityState = "hidden";
  f.document.dispatchEvent(new Event("visibilitychange"));
  expect(f.bridge.saveDraft).toHaveBeenCalledTimes(2);
  update("closing draft");
  f.window.dispatchEvent(new Event("beforeunload"));
  expect(f.bridge.saveDraft.mock.calls[2]).toEqual([
    f.session.id,
    expect.objectContaining({ text: "closing draft" }),
  ]);
  f.unsubscribe();
});

it("saves a newer draft when its timer fires while an earlier request is still pending", async () => {
  const f = await setup();
  await f.store.selectSession(f.session.id);
  vi.useFakeTimers();
  const gate = deferred();
  f.bridge.saveDraft.mockImplementationOnce(async () => {
    await gate.promise;
    return { ok: true, value: undefined };
  });
  const update = (text: string) => {
    const draft = f.store.drafts.get(f.session.id);
    if (!draft) throw new Error("Missing draft");
    f.store.drafts.set(f.session.id, { ...draft, text, selection: [text.length, text.length] });
  };
  update("first");
  await vi.advanceTimersByTimeAsync(200);
  update("latest");
  await vi.advanceTimersByTimeAsync(200);
  expect(f.bridge.saveDraft.mock.calls).toEqual([
    [f.session.id, expect.objectContaining({ text: "first" })],
    [f.session.id, expect.objectContaining({ text: "latest" })],
  ]);
  gate.resolve();
  await f.beforeQuit();
  f.unsubscribe();
});

it("synchronizes the complete worktree environment on creation", async () => {
  const f = await setup();
  const worktree = { branch: "abcd", path: "/trees/abcd/project", sourceCwd: "/project" };
  f.emit({
    sessionId: f.session.id,
    runId: "run",
    seq: 1,
    event: { type: "environment_changed", cwd: worktree.path, newWorktree: true, worktree },
  });
  f.frame();
  expect(f.store.useStore.getState().sessions.get(f.session.id)).toMatchObject({
    cwd: worktree.path,
    newWorktree: true,
    worktree,
  });
  f.unsubscribe();
});

it("retains question drafts across timing updates and releases them when questions end", async () => {
  const f = await setup();
  const draft = { requestId: "q", index: 0, answers: [{ selected: [], custom: "my answer" }] };
  f.store.questionDrafts.set(f.session.id, draft);
  f.emit({
    sessionId: f.session.id,
    runId: "run",
    seq: 1,
    event: { type: "question_changed", question: { id: "q", questions: [] } },
  });
  f.frame();
  expect(f.store.questionDrafts.get(f.session.id)).toBe(draft);
  f.emit({
    sessionId: f.session.id,
    runId: "run",
    seq: 2,
    event: { type: "question_changed", question: null },
  });
  f.frame();
  expect(f.store.questionDrafts.has(f.session.id)).toBe(false);
  f.store.questionDrafts.set(f.session.id, draft);
  f.emit({
    sessionId: f.session.id,
    runId: "run",
    seq: 3,
    event: { type: "settled", status: "aborted", endedAt: 2 },
  });
  f.frame();
  expect(f.store.questionDrafts.has(f.session.id)).toBe(false);
  f.unsubscribe();
});

it("closing a side chat drains active draft writes and releases heavy caches while keeping pane ownership", async () => {
  vi.useFakeTimers();
  const f = await setup();
  const child = { ...f.session, parentSessionId: "parent" };
  f.store.useStore.setState({
    sessions: new Map([[child.id, child]]),
    views: new Map([[child.id, f.snapshot.view]]),
    historyCursors: new Map([[child.id, null]]),
  });
  await f.store.loadDraft(child.id);
  const gate = deferred();
  f.bridge.saveDraft.mockImplementationOnce(async () => {
    await gate.promise;
    return { ok: true, value: undefined };
  });
  const draft = { text: "unsent", selections: [], fileReferences: [], attachments: [], pending: 0 };
  f.store.drafts.set(child.id, draft);
  await vi.advanceTimersByTimeAsync(200);
  f.store.retainedSessionViews.add(child.id);
  f.store.questionDrafts.set(child.id, { requestId: "q", index: 0, answers: [] });
  f.store.useStore.setState({
    suggestions: new Map([[child.id, []]]),
    resourceDiagnostics: new Map([[child.id, []]]),
    historyLoading: new Set([child.id]),
  });
  const closing = f.store.closeSideChat(child.id);
  expect(f.bridge.closeSideChat).not.toHaveBeenCalled();
  f.store.drafts.set(child.id, { ...draft, text: "later edit" });
  await vi.advanceTimersByTimeAsync(200);
  expect(f.bridge.saveDraft).toHaveBeenCalledTimes(1);
  gate.resolve();
  await closing;
  const state = f.store.useStore.getState();
  for (const cache of [
    state.views,
    state.historyCursors,
    state.historyLoading,
    state.suggestions,
    state.resourceDiagnostics,
  ])
    expect(cache.has(child.id)).toBe(false);
  expect(state.sessions.get(child.id)?.parentSessionId).toBe("parent");
  expect(f.store.drafts.has(child.id)).toBe(false);
  expect(f.store.retainedSessionViews.has(child.id)).toBe(false);
  expect(f.store.questionDrafts.has(child.id)).toBe(false);
  f.unsubscribe();
});

it("opening auxiliary views never evicts the selected main conversation", async () => {
  const f = await setup();
  f.store.useStore.setState({
    selected: f.session.id,
    views: new Map([
      [f.session.id, f.snapshot.view],
      ...Array.from({ length: 8 }, (_, index) => {
        const id = `inactive-${index}`;
        return [id, { ...f.snapshot.view, sessionId: id }] as const;
      }),
    ]),
  });
  const child = { ...f.session, id: "child", parentSessionId: f.session.id };
  f.bridge.getSessionSnapshot.mockResolvedValueOnce({
    ok: true,
    value: { ...f.snapshot, session: child, view: { ...f.snapshot.view, sessionId: child.id } },
  });
  const panes = await import("../src/renderer/pane-store.ts");
  await panes.loadSideChat(child.id);
  const views = f.store.useStore.getState().views;
  expect(views.has(f.session.id)).toBe(true);
  expect(views.has(child.id)).toBe(true);
  expect(views.size).toBe(8);
  expect(f.bridge.getDraft).toHaveBeenCalledWith(child.id);
  f.unsubscribe();
});

it("reading the current task clears its completion indicator without reloading the conversation", async () => {
  const f = await setup();
  f.store.useStore.setState({
    selected: f.session.id,
    sessions: new Map([
      [
        f.session.id,
        {
          ...f.session,
          unreadAt: 10,
        },
      ],
    ]),
  });
  await f.store.markSessionRead(f.session.id);
  expect(f.store.useStore.getState().sessions.get(f.session.id)?.unreadAt).toBeUndefined();
  expect(f.bridge.activateSession).toHaveBeenCalledOnce();
  expect(f.bridge.getSessionSnapshot).not.toHaveBeenCalled();
  await f.store.markSessionRead(f.session.id);
  expect(f.bridge.activateSession).toHaveBeenCalledOnce();
  f.unsubscribe();
});

it("a late read acknowledgement preserves a newer completion", async () => {
  const f = await setup();
  f.store.useStore.setState({ sessions: new Map([[f.session.id, { ...f.session, unreadAt: 10 }]]) });
  const gate = deferred();
  f.bridge.activateSession.mockImplementationOnce(async () => {
    await gate.promise;
    return { ok: true, value: { unreadAt: undefined } };
  });
  const reading = f.store.markSessionRead(f.session.id);
  await f.store.markSessionRead(f.session.id);
  expect(f.bridge.activateSession).toHaveBeenCalledOnce();
  f.store.useStore.setState({ sessions: new Map([[f.session.id, { ...f.session, unreadAt: 20 }]]) });
  gate.resolve();
  await reading;
  expect(f.store.useStore.getState().sessions.get(f.session.id)?.unreadAt).toBe(20);
  f.unsubscribe();
});

it.each(["response", "event"])(
  "late history pages cannot restore content removed by a %s reset",
  async (mode) => {
    const f = await setup();
    const run = {
      runId: "removed",
      status: "completed" as const,
      userMessage: "old message",
      orderedBlocks: [],
      finalAnswerBlockIds: [],
      startedAt: 1,
    };
    f.store.useStore.setState({
      views: new Map([[f.session.id, { ...f.snapshot.view, seq: 5, runs: [] }]]),
      historyCursors: new Map([[f.session.id, 10]]),
    });
    const gate = deferred();
    const getHistoryPage = vi.fn(async () => {
      await gate.promise;
      return { ok: true, value: { view: { ...f.snapshot.view, seq: 5, runs: [run] }, cursor: null } };
    });
    Object.assign(f.bridge, { getHistoryPage });
    const loading = f.store.loadEarlier(f.session.id);
    await f.store.loadEarlier(f.session.id);
    expect(getHistoryPage).toHaveBeenCalledOnce();
    const view = { ...f.snapshot.view, seq: 6, runs: [] };
    if (mode === "response")
      f.store.resetSession({
        ...f.snapshot,
        seq: 6,
        view,
        historyCursor: 3,
        controls: {
          selection: null,
          presets: [],
          selectionValid: false,
          model: null,
          thinkingLevel: "off",
          lastThinkingLevel: "off",
          thinkingLevels: [],
          diagnostics: [],
          usage: { contextWindow: 0, inputTokens: null, percent: null, timestamp: null, source: "unknown" },
        },
      });
    else {
      f.emit({ sessionId: f.session.id, runId: "reset", seq: 6, event: { type: "history_reset", view } });
      f.frame();
    }
    gate.resolve();
    await loading;
    expect(f.store.useStore.getState().views.get(f.session.id)?.runs).toEqual([]);
    expect(f.store.useStore.getState().historyCursors.get(f.session.id)).toBe(mode === "response" ? 3 : 10);
    expect(f.store.useStore.getState().historyLoading.has(f.session.id)).toBe(false);
    await f.store.loadEarlier(f.session.id);
    expect(getHistoryPage).toHaveBeenCalledTimes(2);
    f.unsubscribe();
  },
);

it("history pages still merge while newer streaming events arrive", async () => {
  const f = await setup();
  f.store.useStore.setState({
    views: new Map([[f.session.id, f.snapshot.view]]),
    historyCursors: new Map([[f.session.id, 10]]),
  });
  const gate = deferred();
  Object.assign(f.bridge, {
    getHistoryPage: vi.fn(async () => {
      await gate.promise;
      return {
        ok: true,
        value: {
          view: {
            ...f.snapshot.view,
            runs: [
              {
                runId: "old",
                status: "completed",
                userMessage: "old message",
                orderedBlocks: [],
                finalAnswerBlockIds: [],
                startedAt: 1,
              },
            ],
          },
          cursor: null,
        },
      };
    }),
  });
  const loading = f.store.loadEarlier(f.session.id);
  f.emit({
    sessionId: f.session.id,
    runId: "live",
    seq: 1,
    event: { type: "started", text: "live message", startedAt: 2, modelLabel: "model" },
  });
  f.frame();
  gate.resolve();
  await loading;
  expect(
    f.store.useStore
      .getState()
      .views.get(f.session.id)
      ?.runs.map((run) => run.runId),
  ).toEqual(["old", "live"]);
  expect(f.store.useStore.getState().historyCursors.get(f.session.id)).toBeNull();
  f.unsubscribe();
});

it("a late cached-session selection acknowledgement preserves a newer completion", async () => {
  const f = await setup();
  await f.store.selectSession(f.session.id);
  f.store.useStore.setState({ sessions: new Map([[f.session.id, { ...f.session, unreadAt: 10 }]]) });
  const gate = deferred();
  f.bridge.activateSession.mockImplementationOnce(async () => {
    await gate.promise;
    return { ok: true, value: { unreadAt: undefined } };
  });
  const selecting = f.store.selectSession(f.session.id);
  f.store.useStore.setState({ sessions: new Map([[f.session.id, { ...f.session, unreadAt: 20 }]]) });
  gate.resolve();
  await selecting;
  expect(f.store.useStore.getState().sessions.get(f.session.id)?.unreadAt).toBe(20);
  expect(f.bridge.getSessionSnapshot).toHaveBeenCalledOnce();
  f.unsubscribe();
});

it.each(["eviction", "replacement"])(
  "authoritative snapshot after %s invalidates an earlier history request",
  async (mode) => {
    const f = await setup();
    Object.assign(f.snapshot, { seq: 5, view: { ...f.snapshot.view, seq: 5 }, historyCursor: 10 });
    if (mode === "eviction") await f.store.selectSession(f.session.id);
    else
      f.store.useStore.setState({
        selected: f.session.id,
        views: new Map([[f.session.id, f.snapshot.view]]),
        historyCursors: new Map([[f.session.id, 10]]),
      });
    const gate = deferred();
    Object.assign(f.bridge, {
      getHistoryPage: vi.fn(async () => {
        await gate.promise;
        return {
          ok: true,
          value: {
            view: {
              ...f.snapshot.view,
              seq: 5,
              runs: [
                {
                  runId: "removed",
                  status: "completed",
                  userMessage: "obsolete",
                  orderedBlocks: [],
                  finalAnswerBlockIds: [],
                  startedAt: 1,
                },
              ],
            },
            cursor: null,
          },
        };
      }),
    });
    const loading = f.store.loadEarlier(f.session.id);
    for (let index = 0; mode === "eviction" && index < 9; index++) {
      const id = `other-${index}`;
      f.bridge.getSessionSnapshot.mockResolvedValueOnce({
        ok: true,
        value: { ...f.snapshot, session: { ...f.session, id }, view: { ...f.snapshot.view, sessionId: id } },
      });
      await f.store.selectSession(id);
    }
    if (mode === "eviction") expect(f.store.useStore.getState().views.has(f.session.id)).toBe(false);
    Object.assign(f.snapshot, { seq: 6, view: { ...f.snapshot.view, seq: 6 }, historyCursor: 3 });
    await f.store.selectSession(f.session.id);
    gate.resolve();
    await loading;
    expect(f.store.useStore.getState().views.get(f.session.id)?.runs).toEqual([]);
    expect(f.store.useStore.getState().historyCursors.get(f.session.id)).toBe(3);
    expect(f.store.useStore.getState().historyLoading.has(f.session.id)).toBe(false);
    f.unsubscribe();
  },
);

it("a late group refresh cannot overwrite a completed grouping mutation", async () => {
  const f = await setup();
  const gate = deferred();
  f.bridge.getTaskGroups.mockImplementationOnce(async () => {
    await gate.promise;
    return { ok: true, value: emptyTaskGroups() };
  });
  const refreshing = f.store.refresh();
  const next = {
    ...emptyTaskGroups(),
    groups: [{ id: "g", title: "New Group", color: "gray" as const, createdAt: 1 }],
    roots: [{ type: "group" as const, id: "g" }],
    members: { g: [] },
  };
  f.bridge.updateTaskGroups.mockResolvedValueOnce({ ok: true, value: next });
  await f.store.changeTaskGroups({ type: "create" });
  gate.resolve();
  await refreshing;
  expect(f.store.useStore.getState().taskGroups).toEqual(next);
  expect(f.store.useStore.getState().taskGroupsHydrated).toBe(true);
  f.unsubscribe();
});

it("new-task shortcut uses the shared draft path, inheriting the active visible group without reusing another group's or child draft", async () => {
  const f = await setup();
  const groupedDraft = { ...f.session, id: "group-draft", draft: true };
  const rootDraft = { ...f.session, id: "root-draft", draft: true, updatedAt: 99 };
  const childDraft = {
    ...f.session,
    id: "child-draft",
    draft: true,
    parentSessionId: f.session.id,
    updatedAt: 100,
  };
  const sessions = new Map(
    [f.session, groupedDraft, rootDraft, childDraft].map((record) => [record.id, record]),
  );
  f.store.useStore.setState({
    sessions,
    selected: f.session.id,
    taskGroups: {
      version: 1,
      groups: [{ id: "g", title: "G", color: "gray", createdAt: 1 }],
      roots: [
        { type: "group", id: "g" },
        { type: "task", id: rootDraft.id },
      ],
      members: { g: [f.session.id, groupedDraft.id] },
    },
  });
  localStorage.setItem(
    "zpi.sidebarTaskPreferences",
    JSON.stringify({ organizeBy: "grouped", sortBy: "updated" }),
  );
  f.bridge.getSessionSnapshot.mockImplementation(async (id) => ({
    ok: true,
    value: {
      ...f.snapshot,
      session: sessions.get(id ?? "") ?? f.session,
      view: { ...f.snapshot.view, sessionId: id ?? f.session.id },
    },
  }));
  await f.store.newSession();
  expect(f.store.useStore.getState().selected).toBe(groupedDraft.id);
  await f.store.newSession();
  expect(f.store.useStore.getState().selected).toBe(groupedDraft.id);
  await f.store.newSession(null, null);
  expect(f.store.useStore.getState().selected).toBe(rootDraft.id);
  expect(f.bridge.createSession).not.toHaveBeenCalled();
  f.store.useStore.setState({
    selected: f.session.id,
    sessions: new Map(sessions).set(f.session.id, { ...f.session, pinnedAt: 1 }),
  });
  await f.store.newSession();
  expect(f.store.useStore.getState().selected).toBe(rootDraft.id);
  f.unsubscribe();
});

async function groupedDraftNavigation() {
  const f = await setup();
  const first = { ...f.session, id: "draft-a", draft: true };
  const second = { ...f.session, id: "draft-b", draft: true };
  const sessions = new Map([first, second].map((record) => [record.id, record]));
  const taskGroups = {
    ...emptyTaskGroups(),
    groups: ["a", "b"].map((id) => ({ id, title: id, color: "gray" as const, createdAt: 1 })),
    roots: ["a", "b"].map((id) => ({ type: "group" as const, id })),
    members: { a: [first.id], b: [second.id] },
  };
  f.store.useStore.setState({ sessions, taskGroups });
  f.bridge.getSessionSnapshot.mockImplementation(async (id) => ({
    ok: true,
    value: {
      ...f.snapshot,
      session: sessions.get(id ?? "") ?? f.session,
      view: { ...f.snapshot.view, sessionId: id ?? f.session.id },
    },
  }));
  return { ...f, first, second, sessions, taskGroups };
}

it("A-B-A new-task navigation honors the last click while the first draft's resources are still loading", async () => {
  const f = await groupedDraftNavigation();
  const started = deferred(),
    gate = deferred();
  f.bridge.listSessionSkills.mockImplementationOnce(async () => {
    started.resolve();
    await gate.promise;
    return { ok: true, value: { skills: [], diagnostics: [] } };
  });
  const first = f.store.newSession(null, "a");
  await started.promise;
  expect(f.store.useStore.getState().selected).toBe(f.first.id);
  await f.store.newSession(null, "b");
  const last = f.store.newSession(null, "a");
  await vi.waitFor(() => expect(f.store.useStore.getState().selected).toBe(f.first.id));
  gate.resolve();
  expect(await first).toBeUndefined();
  expect(await last).toBe(f.first.id);
  expect(f.store.useStore.getState().selected).toBe(f.first.id);
  expect(f.bridge.createSession).not.toHaveBeenCalled();
  f.unsubscribe();
});

it.each(["creation", "resources"] as const)(
  "a late new-task %s cannot steal a newer manual selection or return its ID for expansion",
  async (phase) => {
    const f = await groupedDraftNavigation();
    const started = deferred(),
      gate = deferred();
    if (phase === "creation") {
      f.store.useStore.setState({ sessions: new Map([[f.second.id, f.second]]) });
      f.bridge.createSession.mockImplementationOnce(async () => {
        started.resolve();
        await gate.promise;
        return { ok: true, value: f.first };
      });
      f.bridge.listRecentSessions.mockResolvedValue({ ok: true, value: [...f.sessions.values()] });
      f.bridge.getTaskGroups.mockResolvedValue({ ok: true, value: f.taskGroups });
    } else {
      f.bridge.listSessionSkills.mockImplementationOnce(async () => {
        started.resolve();
        await gate.promise;
        return { ok: true, value: { skills: [], diagnostics: [] } };
      });
    }
    const opening = f.store.newSession(null, "a");
    await started.promise;
    await f.store.selectSession(f.second.id);
    gate.resolve();
    expect(await opening).toBeUndefined();
    expect(f.store.useStore.getState().selected).toBe(f.second.id);
    f.unsubscribe();
  },
);

it("deduplicates pending draft creation while allowing the latest same-group request to navigate", async () => {
  const f = await groupedDraftNavigation();
  f.store.useStore.setState({ sessions: new Map([[f.second.id, f.second]]) });
  const gate = deferred();
  f.bridge.createSession.mockImplementationOnce(async () => {
    await gate.promise;
    return { ok: true, value: f.first };
  });
  f.bridge.listRecentSessions.mockResolvedValue({ ok: true, value: [...f.sessions.values()] });
  f.bridge.getTaskGroups.mockResolvedValue({ ok: true, value: f.taskGroups });
  const first = f.store.newSession(null, "a");
  await f.store.newSession(null, "b");
  const last = f.store.newSession(null, "a");
  gate.resolve();
  expect(await first).toBeUndefined();
  expect(await last).toBe(f.first.id);
  expect(f.bridge.createSession).toHaveBeenCalledOnce();
  expect(f.store.useStore.getState().selected).toBe(f.first.id);
  f.unsubscribe();
});

it("a slower earlier group creation preserves the newer group's selection and keeps its draft reusable", async () => {
  const f = await groupedDraftNavigation();
  f.store.useStore.setState({ sessions: new Map([[f.second.id, f.second]]) });
  const gate = deferred();
  f.bridge.createSession.mockImplementationOnce(async () => {
    await gate.promise;
    return { ok: true, value: f.first };
  });
  f.bridge.listRecentSessions.mockResolvedValue({ ok: true, value: [...f.sessions.values()] });
  f.bridge.getTaskGroups.mockResolvedValue({ ok: true, value: f.taskGroups });
  const first = f.store.newSession(null, "a");
  expect(await f.store.newSession(null, "b")).toBe(f.second.id);
  gate.resolve();
  expect(await first).toBeUndefined();
  expect(f.store.useStore.getState().selected).toBe(f.second.id);
  expect(await f.store.newSession(null, "a")).toBe(f.first.id);
  expect(f.bridge.createSession).toHaveBeenCalledOnce();
  f.unsubscribe();
});

it("a failed draft creation releases its deduplication entry so the next request can retry", async () => {
  const f = await groupedDraftNavigation();
  f.store.useStore.setState({ sessions: new Map([[f.second.id, f.second]]) });
  f.bridge.createSession.mockRejectedValueOnce(new Error("disk full"));
  await expect(f.store.newSession(null, "a")).rejects.toThrow("disk full");
  f.bridge.createSession.mockResolvedValueOnce({ ok: true, value: f.first });
  f.bridge.listRecentSessions.mockResolvedValue({ ok: true, value: [...f.sessions.values()] });
  f.bridge.getTaskGroups.mockResolvedValue({ ok: true, value: f.taskGroups });
  expect(await f.store.newSession(null, "a")).toBe(f.first.id);
  expect(f.bridge.createSession).toHaveBeenCalledTimes(2);
  f.unsubscribe();
});

it.each([true, false])(
  "new-task focus ignores hidden retained dialogs but respects visible ones (hidden=%s)",
  async (hidden) => {
    const f = await groupedDraftNavigation();
    const blocker = {
      closest: () => (hidden ? {} : null),
      getClientRects: () => [{}],
    };
    const editor = { isConnected: true, closest: () => null, getClientRects: () => [{}], focus: vi.fn() };
    Object.assign(f.document, {
      querySelectorAll: () => [blocker],
      querySelector: (selector: string) => (selector.includes('[role="dialog"]') ? blocker : editor),
    });
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
    expect(await f.store.newSession(null, "a")).toBe(f.first.id);
    f.frame();
    expect(editor.focus).toHaveBeenCalledTimes(hidden ? 1 : 0);
    f.unsubscribe();
  },
);

it("a failed group command does not invalidate initial hydration or prune saved collapsed groups", async () => {
  const f = await groupedDraftNavigation();
  const { pruneCollapsedTaskGroups } = await import("../src/renderer/task-group-expansion.ts");
  f.store.useStore.setState({ taskGroups: emptyTaskGroups(), taskGroupsHydrated: false });
  const gate = deferred();
  f.bridge.getTaskGroups.mockImplementationOnce(async () => {
    await gate.promise;
    return { ok: true, value: f.taskGroups };
  });
  const refreshing = f.store.refresh();
  f.bridge.updateTaskGroups.mockRejectedValueOnce(new Error("disk full"));
  await expect(f.store.changeTaskGroups({ type: "create" })).rejects.toThrow("disk full");
  gate.resolve();
  await refreshing;
  const state = f.store.useStore.getState();
  expect(state.taskGroups).toEqual(f.taskGroups);
  expect(
    pruneCollapsedTaskGroups(
      ["a"],
      state.taskGroups.groups.map((g) => g.id),
      state.taskGroupsHydrated,
    ),
  ).toEqual(["a"]);
  f.unsubscribe();
});

it("an older successful group response cannot overwrite a newer completed command", async () => {
  const f = await groupedDraftNavigation();
  const gate = deferred();
  const later = structuredClone(f.taskGroups);
  later.groups[0].title = "latest";
  f.bridge.updateTaskGroups.mockImplementationOnce(async () => {
    await gate.promise;
    return { ok: true, value: f.taskGroups };
  });
  f.bridge.updateTaskGroups.mockResolvedValueOnce({ ok: true, value: later });
  const first = f.store.changeTaskGroups({ type: "rename", id: "a", title: "a" });
  await f.store.changeTaskGroups({ type: "rename", id: "a", title: "latest" });
  gate.resolve();
  await first;
  expect(f.store.useStore.getState().taskGroups).toEqual(later);
  f.unsubscribe();
});

it("a later failed group command does not suppress an earlier successful response", async () => {
  const f = await groupedDraftNavigation();
  const gate = deferred();
  const saved = structuredClone(f.taskGroups);
  saved.groups[0].title = "saved";
  f.bridge.updateTaskGroups.mockImplementationOnce(async () => {
    await gate.promise;
    return { ok: true, value: saved };
  });
  const first = f.store.changeTaskGroups({ type: "rename", id: "a", title: "saved" });
  f.bridge.updateTaskGroups.mockRejectedValueOnce(new Error("disk full"));
  await expect(f.store.changeTaskGroups({ type: "create" })).rejects.toThrow("disk full");
  gate.resolve();
  await first;
  expect(f.store.useStore.getState().taskGroups).toEqual(saved);
  f.unsubscribe();
});

it("flushes pending and incoming events while hidden without animation frames", async () => {
  const f = await setup();
  f.emit({
    sessionId: f.session.id,
    runId: "title",
    seq: 1,
    event: { type: "session_changed", title: "before hiding" },
  });
  expect(f.store.useStore.getState().sessions.get(f.session.id)?.title).toBe("Task");
  f.document.visibilityState = "hidden";
  f.document.dispatchEvent(new Event("visibilitychange"));
  expect(f.store.useStore.getState().sessions.get(f.session.id)?.title).toBe("before hiding");
  f.emit({
    sessionId: f.session.id,
    runId: "title",
    seq: 2,
    event: { type: "session_changed", title: "hidden update" },
  });
  expect(f.store.useStore.getState().sessions.get(f.session.id)?.title).toBe("hidden update");
  f.unsubscribe();
});
