import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ModelPerformance } from "../src/renderer/ModelPerformance.tsx";
import type { Result, SessionRecord, SessionSnapshot } from "../src/shared/bridge.ts";

// Native terminal rendering is outside these Node-only loading-shell checks.
vi.mock("../src/renderer/TerminalPane.tsx", () => ({ TerminalPane: () => null }));

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
afterEach(() => vi.unstubAllGlobals());
async function setup() {
  vi.resetModules();
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("document", { activeElement: undefined });
  const frames = vi.fn();
  vi.stubGlobal("requestAnimationFrame", frames);
  const parent: SessionRecord = {
    id: "parent",
    title: "Parent",
    projectId: null,
    createdAt: 0,
    updatedAt: 0,
  };
  const child = { ...parent, id: "child", parentSessionId: parent.id };
  const snapshot: SessionSnapshot = {
    session: child,
    view: { sessionId: child.id, title: child.title, seq: 0, runs: [] },
    seq: 0,
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
  };
  const bridge = {
    createSideChat: vi.fn(async (): Promise<Result<SessionRecord>> => ok(child)),
    getSessionSnapshot: vi.fn(async (): Promise<Result<SessionSnapshot>> => ok(snapshot)),
    getDraft: vi.fn(async () =>
      ok({ text: "saved draft", fileReferences: [], selection: [0, 0], revision: 0 }),
    ),
    listCommands: vi.fn(async () => ok([])),
    listSessionSkills: vi.fn(async () => ok({ skills: [], diagnostics: [] })),
    closeSideChat: vi.fn(async () => ok(undefined)),
    onPaneEvent: vi.fn(() => () => {}),
    logError: vi.fn(),
  };
  vi.stubGlobal("window", Object.assign(new EventTarget(), { zpi: bridge }));
  const store = await import("../src/renderer/store.ts");
  const pane = await import("../src/renderer/pane-store.ts");
  store.useStore.setState({ selected: parent.id, sessions: new Map([[parent.id, parent]]) });
  const off = pane.listenPanes();
  return { store, pane, bridge, parent, child, snapshot, frames, off };
}

it("shows a shell immediately, deduplicates clicks, and waits for the draft but not suggestions", async () => {
  const f = await setup();
  const draft = Promise.withResolvers<Awaited<ReturnType<typeof f.bridge.getDraft>>>();
  const skills = Promise.withResolvers<Awaited<ReturnType<typeof f.bridge.listSessionSkills>>>();
  f.bridge.getDraft.mockReturnValueOnce(draft.promise);
  f.bridge.listSessionSkills.mockReturnValueOnce(skills.promise);
  const first = f.pane.openSideChat(f.parent.id);
  const second = f.pane.openSideChat(f.parent.id);
  expect(f.pane.usePane.getState()).toMatchObject({ open: true, tabs: [{ type: "side-chat-loading" }] });
  expect(f.bridge.createSideChat).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(f.bridge.getDraft).toHaveBeenCalled());
  expect(f.pane.visiblePaneTabs(f.parent.id)[0].type).toBe("side-chat-loading");
  expect(f.store.useStore.getState().views.has(f.child.id)).toBe(false);
  draft.resolve(ok({ text: "saved draft", fileReferences: [], selection: [0, 0], revision: 0 }));
  await Promise.all([first, second]);
  expect(f.pane.visiblePaneTabs(f.parent.id)[0]).toMatchObject({
    type: "side-chat",
    childSessionId: f.child.id,
  });
  expect(f.store.drafts.get(f.child.id)?.text).toBe("saved draft");
  expect(f.store.useStore.getState().suggestions.has(f.child.id)).toBe(false);
  await f.pane.closeTab(f.pane.usePane.getState().active ?? "");
  skills.resolve(ok({ skills: [], diagnostics: [] }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.store.useStore.getState().suggestions.has(f.child.id)).toBe(false);
  f.off();
});

it.each(["collapse", "switch", "other-tab"])("does not reopen or steal focus after %s", async (action) => {
  const f = await setup();
  const created = Promise.withResolvers<Result<SessionRecord>>();
  f.bridge.createSideChat.mockReturnValueOnce(created.promise);
  const opening = f.pane.openSideChat(f.parent.id);
  if (action === "collapse") f.pane.setPaneOpen(false);
  if (action === "switch") f.store.useStore.setState({ selected: "other" });
  if (action === "other-tab") f.pane.openChanges(f.parent.id, null);
  const before = f.pane.usePane.getState();
  created.resolve(ok(f.child));
  await opening;
  expect(f.pane.usePane.getState()).toMatchObject({ open: before.open, active: before.active });
  expect(f.frames).not.toHaveBeenCalled();
  expect(f.pane.visiblePaneTabs(f.parent.id)[0].type).toBe("side-chat");
  f.off();
});

it.each(["create", "draft"])(
  "closing during %s ignores late results and cleans the created child",
  async (phase) => {
    const f = await setup();
    const created = Promise.withResolvers<Result<SessionRecord>>();
    const draft = Promise.withResolvers<Awaited<ReturnType<typeof f.bridge.getDraft>>>();
    f.bridge.createSideChat.mockReturnValueOnce(created.promise);
    f.bridge.getDraft.mockReturnValueOnce(draft.promise);
    const opening = f.pane.openSideChat(f.parent.id);
    if (phase === "draft") {
      created.resolve(ok(f.child));
      await vi.waitFor(() => expect(f.bridge.getDraft).toHaveBeenCalled());
    }
    await f.pane.closeTab(f.pane.usePane.getState().active ?? "");
    expect(f.pane.visiblePaneTabs(f.parent.id)).toHaveLength(0);
    created.resolve(ok(f.child));
    draft.resolve(ok({ text: "late", fileReferences: [], selection: [0, 0], revision: 0 }));
    await opening;
    expect(f.bridge.closeSideChat).toHaveBeenCalledExactlyOnceWith(f.child.id);
    expect(f.pane.visiblePaneTabs(f.parent.id)).toHaveLength(0);
    expect(f.store.retainedSessionViews.has(f.child.id)).toBe(false);
    expect(f.store.drafts.has(f.child.id)).toBe(false);
    expect(f.store.useStore.getState().views.has(f.child.id)).toBe(false);
    expect(f.frames).not.toHaveBeenCalled();
    f.off();
  },
);

it("an old cancelled request cannot replace or cancel a newer opening", async () => {
  const f = await setup();
  const old = Promise.withResolvers<Result<SessionRecord>>();
  f.bridge.createSideChat.mockReturnValueOnce(old.promise);
  const first = f.pane.openSideChat(f.parent.id);
  await f.pane.closeTab(f.pane.usePane.getState().active ?? "");
  await f.pane.openSideChat(f.parent.id);
  const current = f.pane.usePane.getState().active;
  old.resolve(ok({ ...f.child, id: "old-child" }));
  await first;
  expect(f.pane.usePane.getState().active).toBe(current);
  expect(f.pane.visiblePaneTabs(f.parent.id)).toHaveLength(1);
  expect(f.bridge.closeSideChat).toHaveBeenCalledExactlyOnceWith("old-child");
  f.off();
});

it.each(["create", "snapshot", "draft"])("cleans a failed %s and permits retry", async (phase) => {
  const f = await setup();
  const failure = new Error("load failed");
  if (phase === "create") f.bridge.createSideChat.mockRejectedValueOnce(failure);
  if (phase === "snapshot") f.bridge.getSessionSnapshot.mockRejectedValueOnce(failure);
  if (phase === "draft") f.bridge.getDraft.mockRejectedValueOnce(failure);
  await expect(f.pane.openSideChat(f.parent.id)).rejects.toThrow("load failed");
  expect(f.pane.visiblePaneTabs(f.parent.id)).toHaveLength(0);
  expect(f.store.retainedSessionViews.has(f.child.id)).toBe(false);
  await f.pane.openSideChat(f.parent.id);
  expect(f.pane.visiblePaneTabs(f.parent.id)[0].type).toBe("side-chat");
  f.off();
});

it("hides unknown turns while preserving steps and token usage", () => {
  const html = renderToStaticMarkup(
    createElement(ModelPerformance, { value: { steps: 7, outputTokens: 500 } }),
  );
  expect(html).toContain("7 步");
  expect(html).toContain("500 tok");
  expect(html).not.toContain("轮");
  expect(renderToStaticMarkup(createElement(ModelPerformance, { value: { turns: 2, steps: 7 } }))).toContain(
    "2 轮 7 步",
  );
});

it("archiving the parent cancels its loading shell and cleans the late child", async () => {
  const f = await setup();
  const created = Promise.withResolvers<Result<SessionRecord>>();
  f.bridge.createSideChat.mockReturnValueOnce(created.promise);
  const opening = f.pane.openSideChat(f.parent.id);
  f.store.useStore.setState({ sessions: new Map([[f.parent.id, { ...f.parent, archivedAt: 1 }]]) });
  expect(f.pane.visiblePaneTabs(f.parent.id)).toHaveLength(0);
  created.resolve(ok(f.child));
  await opening;
  expect(f.bridge.closeSideChat).toHaveBeenCalledExactlyOnceWith(f.child.id);
  expect(f.frames).not.toHaveBeenCalled();
  f.off();
});

it("adds references to the ready draft and never resurrects a closed existing tab", async () => {
  const f = await setup();
  await f.pane.openSideChat(f.parent.id);
  await f.pane.openSideChat(f.parent.id, { text: "selected passage" });
  expect(f.store.drafts.get(f.child.id)?.selections?.[0].text).toBe("selected passage");
  await f.pane.openSideChat(f.parent.id, { text: "second passage" });
  expect(f.store.drafts.get(f.child.id)?.selections?.map((item) => item.text)).toEqual([
    "selected passage",
    "second passage",
  ]);
  expect(f.bridge.createSideChat).toHaveBeenCalledTimes(1);
  const snapshot = Promise.withResolvers<Result<SessionSnapshot>>();
  f.bridge.getSessionSnapshot.mockReturnValueOnce(snapshot.promise);
  const opening = f.pane.openSideChat(f.parent.id, { text: "late passage" });
  await f.pane.closeTab(f.pane.usePane.getState().active ?? "");
  f.frames.mockClear();
  snapshot.resolve(ok(f.snapshot));
  await opening;
  expect(f.pane.visiblePaneTabs(f.parent.id)).toHaveLength(0);
  expect(f.store.drafts.has(f.child.id)).toBe(false);
  expect(f.frames).not.toHaveBeenCalled();
  f.off();
});

it("suggestion failure leaves the conversation editable and reports the optional failure", async () => {
  const f = await setup();
  f.bridge.listSessionSkills.mockRejectedValueOnce(new Error("skills unavailable"));
  await f.pane.openSideChat(f.parent.id);
  await vi.waitFor(() => expect(f.store.useStore.getState().error).toContain("skills unavailable"));
  expect(f.pane.visiblePaneTabs(f.parent.id)[0].type).toBe("side-chat");
  expect(f.store.drafts.get(f.child.id)?.text).toBe("saved draft");
  expect(f.bridge.closeSideChat).not.toHaveBeenCalled();
  f.off();
});

it("renders the creation shell without mounting an editable composer", async () => {
  const f = await setup();
  const created = Promise.withResolvers<Result<SessionRecord>>();
  f.bridge.createSideChat.mockReturnValueOnce(created.promise);
  const opening = f.pane.openSideChat(f.parent.id);
  const { RightPane } = await import("../src/renderer/RightPane.tsx");
  // React SSR reads Zustand’s initial snapshot rather than its live browser snapshot.
  Object.assign(f.pane.usePane.getInitialState(), f.pane.usePane.getState());
  const html = renderToStaticMarkup(
    createElement(RightPane, { available: 1200, sessionId: f.parent.id, onSettings: () => {} }),
  );
  expect(html).toContain("正在创建辅助对话");
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain('contenteditable="true"');
  await f.pane.closeTab(f.pane.usePane.getState().active ?? "");
  created.resolve(ok(f.child));
  await opening;
  f.off();
});
