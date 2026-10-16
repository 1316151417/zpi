import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { Conversation } from "zpi-ui";
import type { Result } from "../src/shared/bridge.ts";

const f = vi.hoisted(() => ({
  props: undefined as ComponentProps<typeof Conversation> | undefined,
  readPatch: vi.fn(),
  state: {
    views: new Map([["child", { sessionId: "child", seq: 0, runs: [] }]]),
    sessions: new Map(),
    settings: undefined,
    suggestions: new Map(),
    historyCursors: new Map(),
    historyLoading: new Set(),
  },
}));
vi.mock("zpi-ui", () => ({
  Conversation: (props: ComponentProps<typeof Conversation>) => {
    f.props = props;
    return null;
  },
  ChatComposer: () => null,
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: (select: (state: typeof f.state) => unknown) => select(f.state),
  unwrap: (r: Result<unknown>) => {
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  },
  drafts: {},
  loadEarlier: vi.fn(),
  queueActions: () => ({}),
  report: vi.fn(),
  addConversationSelection: vi.fn(),
}));
vi.mock("../src/renderer/pane-store.ts", () => ({
  openChanges: vi.fn(),
  openFile: vi.fn(),
  openWebLink: vi.fn(),
  paneTask: vi.fn(),
}));
vi.mock("../src/renderer/use-workspace.ts", () => ({ useWorkspace: () => undefined }));
vi.mock("../src/renderer/preview-services.ts", () => ({ previewServices: {} }));
vi.mock("../src/renderer/composer-context.ts", () => ({ inputContext: {} }));
vi.mock("../src/renderer/SessionToolbar.tsx", () => ({ SessionToolbar: () => null }));
vi.mock("../src/renderer/UserQuestionCard.tsx", () => ({ UserQuestionCard: () => null }));

import { SideChatPane } from "../src/renderer/SideChatPane.tsx";
import { SubagentPane } from "../src/renderer/SubagentPane.tsx";

afterEach(() => vi.unstubAllGlobals());

it.each(["side", "subagent"])("%s sends per-operation patch key", async (kind) => {
  f.props = undefined;
  f.readPatch.mockClear();
  vi.stubGlobal("window", {
    zpi: { readPatch: f.readPatch.mockResolvedValue({ ok: true, value: "patch" }) },
  });
  renderToStaticMarkup(
    kind === "side"
      ? createElement(SideChatPane, { sessionId: "child", visible: true, onSettings: () => {} })
      : createElement(SubagentPane, {
          tab: { id: "tab", type: "subagent", title: "child", sessionId: "parent", childSessionId: "child" },
        }),
  );
  const loadPatch = (f.props as ComponentProps<typeof Conversation> | undefined)?.onLoadToolPatch;
  if (!loadPatch) throw new Error("Conversation patch callback missing");
  await loadPatch("run", "tool-id");
  expect(f.readPatch).toHaveBeenCalledExactlyOnceWith("child", "run", "operation:tool-id");
});
