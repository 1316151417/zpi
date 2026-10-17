import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskMenuItems } from "../src/renderer/TaskMenuItems.tsx";
import type { SessionRecord } from "../src/shared/bridge.ts";

const state = vi.hoisted(() => ({
  sessions: new Map<string, Partial<SessionRecord>>(),
  items: [] as { disabled?: boolean; onSelect?: () => void }[],
  refresh: vi.fn().mockResolvedValue(undefined),
  archive: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: (selector: (value: typeof state) => unknown) => selector(state),
  refresh: state.refresh,
  archiveSession: state.archive,
  report: vi.fn(),
}));
vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Item: (props: { children: ReactNode; disabled?: boolean; onSelect?: () => void }) => {
    state.items.push(props);
    return createElement("button", { disabled: props.disabled }, props.children);
  },
  Separator: () => createElement("hr"),
}));
const record = {
  id: "task",
  title: "Task",
  projectId: "project",
  createdAt: 0,
  updatedAt: 0,
} as SessionRecord;
const pin = vi.fn().mockResolvedValue({ ok: true, value: undefined });
function render(overrides: Partial<SessionRecord> = {}, onRename = vi.fn()) {
  return renderToStaticMarkup(
    createElement(TaskMenuItems, { record: { ...record, ...overrides }, onRename }),
  );
}
beforeEach(() => {
  state.items = [];
  state.sessions.clear();
  vi.clearAllMocks();
  vi.stubGlobal("document", { baseURI: "http://localhost/" });
  vi.stubGlobal("window", { zpi: { setSessionPinned: pin } });
});
afterEach(() => vi.unstubAllGlobals());

describe("shared task menu actions", () => {
  it("keeps header ordering, icons and labels without obsolete actions", () => {
    const html = render();
    const labels = ["置顶", "重命名任务", "归档任务", "Finder", "复制路径", "复制会话路径"];
    let previous = -1;
    for (const label of labels) {
      const index = html.indexOf(label);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    expect(state.items).toHaveLength(labels.length);
    expect(html.match(/<svg/g)).toHaveLength(5);
    expect(html).toContain("<img");
    expect(html).not.toContain("标记未读");
    expect(html).not.toContain("复制会话 ID");
  });

  it.each([false, true])("toggles pinned=%s and refreshes", async (pinned) => {
    render({ pinnedAt: pinned ? 1 : undefined });
    state.items[0].onSelect?.();
    await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
    expect(pin).toHaveBeenCalledWith(record.id, !pinned);
  });

  it("disables new pins at the limit but still permits unpinning", () => {
    for (let index = 0; index < 5; index++) state.sessions.set(String(index), { pinnedAt: index });
    render();
    expect(state.items[0].disabled).toBe(true);
    state.items = [];
    expect(render({ pinnedAt: 1 })).toContain("取消置顶");
    expect(state.items[0].disabled).toBe(false);
  });

  it("preserves rename callback and running/diagnostic restrictions", () => {
    const rename = vi.fn();
    render({}, rename);
    state.items[1].onSelect?.();
    expect(rename).toHaveBeenCalledOnce();
    state.items = [];
    render({ status: "running" });
    expect(state.items[2].disabled).toBe(true);
    state.items = [];
    render({ running: true });
    expect(state.items[2].disabled).toBe(true);
    state.items = [];
    render({ diagnostic: "invalid" as SessionRecord["diagnostic"] });
    expect(state.items[1].disabled).toBe(true);
    expect(state.items[2].disabled).toBe(true);
  });
});
