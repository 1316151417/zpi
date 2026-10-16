import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => (hooks.values[index] = value)];
  },
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("zpi-ui", async (original) => ({
  ...(await original<typeof import("zpi-ui")>()),
  useAppearance: () => ({ theme: "light" }),
}));
vi.mock("../src/renderer/store.ts", async () => {
  const { ComposerDraftStore } = await import("zpi-ui");
  const state = { selected: "main", sessions: new Map(), views: new Map() };
  return {
    drafts: new ComposerDraftStore(),
    useStore: (selector: (state: unknown) => unknown) => selector(state),
  };
});
vi.mock("../src/renderer/pane-store.ts", () => ({ useSideChatBlocked: () => false }));
vi.mock("../src/renderer/use-workspace.ts", () => ({ useWorkspace: () => undefined }));
vi.mock("../src/renderer/PreviewHeader.tsx", () => ({ PreviewHeader: () => null }));

import { File } from "@pierre/diffs/react";
import { FilePane } from "../src/renderer/FilePane.tsx";
import { drafts } from "../src/renderer/store.ts";

type ViewerProps = {
  selectedLines: { start: number; end: number } | null;
  lineAnnotations: unknown[];
  options: { onLineSelectionEnd: (range: { start: number; end: number }) => void };
  renderAnnotation: (annotation: { metadata: { kind: "draft" } }) => ReactElement<{
    onCancel: () => void;
    onSubmit: () => void;
    onText: (text: string) => void;
    error: string;
  }>;
};
function findFile(node: ReactNode): ReactElement<ViewerProps> | undefined {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.map(findFile).find(Boolean);
  const element = node as ReactElement<{ children?: ReactNode }>;
  return element.type === File
    ? (element as unknown as ReactElement<ViewerProps>)
    : findFile(element.props?.children);
}
function render(location?: { line: number; endLine?: number }) {
  hooks.cursor = 0;
  const file = findFile(
    FilePane({
      sessionId: "main",
      preview: { kind: "text", truncated: false, path: "/example.ts", text: "one\ntwo\nthree", location },
    }),
  );
  if (!file) throw new Error("Missing File viewer");
  return file.props;
}
beforeEach(() => {
  hooks.values = [];
  drafts.set("main", { text: "keep", fileReferences: [], attachments: [], pending: 0, selections: [] });
});

test("controls Pierre selection through draft, cancel, submit and repeated comment flows", () => {
  expect(render().selectedLines).toBeNull();
  render().options.onLineSelectionEnd({ start: 2, end: 3 });
  const editing = render();
  expect(editing.selectedLines).toEqual({ start: 2, end: 3 });
  editing.renderAnnotation({ metadata: { kind: "draft" } }).props.onCancel();
  expect(render().selectedLines).toBeNull();
  render().options.onLineSelectionEnd({ start: 1, end: 1 });
  render()
    .renderAnnotation({ metadata: { kind: "draft" } })
    .props.onSubmit();
  const submitted = render();
  expect(submitted.selectedLines).toBeNull();
  expect(submitted.lineAnnotations).toHaveLength(1);
  expect(drafts.get("main")?.text).toBe("keep");
  submitted.options.onLineSelectionEnd({ start: 3, end: 3 });
  expect(render().selectedLines).toEqual({ start: 3, end: 3 });
});

test("preserves an explicit navigation range when a comment draft closes", () => {
  expect(render({ line: 2 }).selectedLines).toEqual({ start: 2, end: 2 });
  render({ line: 2 }).options.onLineSelectionEnd({ start: 3, end: 3 });
  const editing = render({ line: 2 });
  expect(editing.selectedLines).toEqual({ start: 3, end: 3 });
  editing.renderAnnotation({ metadata: { kind: "draft" } }).props.onCancel();
  expect(render({ line: 2 }).selectedLines).toEqual({ start: 2, end: 2 });
});

test("failed comment submission keeps the active selection and draft for correction", () => {
  render().options.onLineSelectionEnd({ start: 1, end: 2 });
  render()
    .renderAnnotation({ metadata: { kind: "draft" } })
    .props.onText("x".repeat(8100));
  render()
    .renderAnnotation({ metadata: { kind: "draft" } })
    .props.onSubmit();
  const failed = render();
  expect(failed.selectedLines).toEqual({ start: 1, end: 2 });
  expect(failed.renderAnnotation({ metadata: { kind: "draft" } }).props.error).toContain("8,000");
  expect(drafts.get("main")?.selections).toEqual([]);
});
