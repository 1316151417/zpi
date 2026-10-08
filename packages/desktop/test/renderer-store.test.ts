import type { DesktopEventEnvelope } from "ZPI-ui";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../../../tests/fake-server.ts";
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
    activateSession: vi.fn(async () => ({ ok: true, value: { unreadAt: null } })),
    getDraft: vi.fn(async () => ({
      ok: true,
      value: { text: "", fileReferences: [], selection: [0, 0], revision: 0 },
    })),
    saveDraft: vi.fn(async () => ({ ok: true, value: undefined })),
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
  const window = Object.assign(new EventTarget(), { ZPI: bridge });
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
