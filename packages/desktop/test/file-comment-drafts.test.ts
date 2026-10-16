import { expect, test } from "vitest";
import { ComposerDraftStore } from "zpi-ui";
import {
  addFileCommentToDraft,
  fileComments,
  removeFileCommentFromDraft,
} from "../src/renderer/file-comments.ts";

function fixture() {
  const store = new ComposerDraftStore();
  for (const id of ["main", "side"])
    store.set(id, {
      text: `${id} untouched`,
      fileReferences: [],
      attachments: [],
      pending: 0,
      selections: [],
    });
  return store;
}
const path = "/workspace/notes.ts";
const source = "first\nsecond\nthird";

test("adding a side-file comment mutates only its own existing draft and not the selected main task", () => {
  const store = fixture();
  const main = store.get("main");
  const changed: string[] = [];
  const off = store.subscribe((id) => changed.push(id));
  addFileCommentToDraft(store, "side", path, source, { start: 3, end: 2 }, "解释边界", "side-note");
  expect(store.get("main")).toBe(main);
  expect(store.get("side")?.text).toBe("side untouched");
  expect(store.get("side")?.selections?.[0]).toMatchObject({
    id: "side-note",
    path,
    text: "第 2–3 行\nsecond\nthird\n\n备注：解释边界",
  });
  expect(changed).toEqual(["side"]);
  off();
});

test("removing a comment preserves other references, text and the other session even when IDs collide", () => {
  const store = fixture();
  addFileCommentToDraft(store, "main", path, source, { start: 1, end: 1 }, "main", "same-id");
  addFileCommentToDraft(store, "side", path, source, { start: 2, end: 2 }, "side", "same-id");
  addFileCommentToDraft(store, "side", path, source, { start: 3, end: 3 }, "retain", "retain");
  const main = store.get("main");
  removeFileCommentFromDraft(store, "side", "same-id");
  expect(store.get("main")).toBe(main);
  expect(store.get("side")?.text).toBe("side untouched");
  expect(store.get("side")?.selections?.map((item) => item.id)).toEqual(["retain"]);
  expect(fileComments(store.get("side")?.selections ?? [], path)).toEqual([
    { id: "retain", start: 3, end: 3, comment: "retain" },
  ]);
});

test("composer removal immediately removes the preview projection without touching another file or session", () => {
  const store = fixture();
  addFileCommentToDraft(store, "side", path, source, { start: 1, end: 1 }, "", "note");
  addFileCommentToDraft(store, "side", "/workspace/other.ts", source, { start: 2, end: 2 }, "", "other");
  const main = store.get("main");
  const draft = store.get("side");
  if (!draft) throw new Error("missing draft");
  store.set("side", { ...draft, selections: draft.selections?.filter((item) => item.id !== "note") });
  expect(fileComments(store.get("side")?.selections ?? [], path)).toEqual([]);
  expect(fileComments(store.get("side")?.selections ?? [], "/workspace/other.ts")).toHaveLength(1);
  expect(store.get("main")).toBe(main);
});

test("missing draft and oversized context fail atomically without redirecting to another draft", () => {
  const store = fixture();
  const main = store.get("main");
  const side = store.get("side");
  expect(() =>
    addFileCommentToDraft(store, "missing", path, source, { start: 1, end: 1 }, "note", "missing"),
  ).toThrow();
  expect(() =>
    addFileCommentToDraft(store, "side", path, "x".repeat(8000), { start: 1, end: 1 }, "note", "large"),
  ).toThrow("8,000");
  expect(store.get("main")).toBe(main);
  expect(store.get("side")).toBe(side);
  expect(store.get("missing")).toBeUndefined();
});
