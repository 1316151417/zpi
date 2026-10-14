import { expect, it, vi } from "vitest";
import { DraftStore } from "../src/main/draft-store.ts";
import { StateStore } from "../src/main/state-store.ts";

it("persists draft selection and revisions, rejects stale writes, and deletes current state", () => {
  const state = new StateStore(":memory:");
  try {
    state.upsertTask({ id: "task", title: "Task", projectId: null, createdAt: 1, updatedAt: 1 });
    const store = new DraftStore(state);
    expect(store.get("task")).toEqual({ text: "", fileReferences: [], selection: [0, 0], revision: 0 });
    const current = {
      text: "中文 draft",
      fileReferences: ["/missing.txt"],
      selection: [1, 3] as [number, number],
      revision: 2,
    };
    store.save("task", current);
    store.save("task", { ...current, text: "stale", revision: 1 });
    expect(new DraftStore(state).get("task")).toEqual(current);
    const detached = store.get("task");
    detached.text = "mutated";
    expect(store.get("task")).toEqual(current);
    const fail = vi.spyOn(state, "saveDraft").mockImplementation(() => {
      throw new Error("commit failed");
    });
    expect(() => store.save("task", { ...current, revision: 3 })).toThrow("commit failed");
    expect(store.get("task")).toEqual(current);
    fail.mockRestore();
    store.delete("task");
    expect(store.get("task").revision).toBe(0);
  } finally {
    state.close();
  }
});
it("rejects invalid draft records and identifiers without discarding stored data", () => {
  const state = new StateStore(":memory:");
  try {
    state.upsertTask({ id: "task", title: "Task", projectId: null, createdAt: 1, updatedAt: 1 });
    const store = new DraftStore(state);
    const value = { text: "valid", fileReferences: [], selection: [0, 5] as [number, number], revision: 1 };
    store.save("task", value);
    expect(() => store.save("task", { ...value, selection: [0, 6] })).toThrow("无效草稿");
    for (const id of ["../outside", "", "a/b"]) {
      expect(() => store.get(id)).toThrow();
      expect(() => store.save(id, value)).toThrow();
      expect(() => store.delete(id)).toThrow();
    }
    expect(store.get("task")).toEqual(value);
    state.db.prepare("UPDATE drafts SET data=? WHERE task_id=?").run('{"text":42,"revision":1}', "task");
    expect(() => store.get("task")).toThrow("无效草稿");
    expect(state.getDraft("task")).toEqual({ text: 42, revision: 1 });
  } finally {
    state.close();
  }
});
