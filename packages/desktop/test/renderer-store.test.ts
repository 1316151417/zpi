import { afterEach, expect, it, vi } from "vitest";
import type { DesktopEventEnvelope } from "zpi-ui";
import { shallow } from "zustand/shallow";
import { deferred } from "../../../tests/fake-server.ts";
import { selectAppState, selectTaskRecords } from "../src/renderer/app-state.ts";
import type { SessionRecord } from "../src/shared/bridge.ts";

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
  });
  const frames: FrameRequestCallback[] = [];
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
    getSettings: vi.fn(async () => ({ ok: true, value: {} })),
    activateSession: vi.fn(async () => ({ ok: true, value: { unreadAt: undefined } })),
    getDraft: vi.fn(async () => ({
      ok: true,
      value: { text: "", fileReferences: [], selection: [0, 0], revision: 0 },
    })),
    saveDraft: vi.fn(async () => ({ ok: true, value: undefined })),
    closeSideChat: vi.fn(async () => ({ ok: true, value: undefined })),
    getSessionSnapshot: vi.fn(async () => ({ ok: true, value: snapshot })),
    listCommands: vi.fn(async () => ({ ok: true, value: [] })),
    listSessionSkills: vi.fn(async () => ({ ok: true, value: { skills: [], diagnostics: [] } })),
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
