import { expect, it } from "vitest";
import { expandTaskGroup } from "../src/renderer/task-group-expansion.ts";

it("reveals a new or reused grouped draft without expanding unrelated groups", () => {
  const collapsed = ["draft-group", "other-group"];
  expect(expandTaskGroup(collapsed, "draft-group")).toEqual(["other-group"]);
  expect(collapsed).toEqual(["draft-group", "other-group"]);
});

it("preserves collapse state for root drafts and already expanded groups", () => {
  const collapsed = ["other-group"];
  expect(expandTaskGroup(collapsed, null)).toBe(collapsed);
  expect(expandTaskGroup(collapsed, "draft-group")).toBe(collapsed);
});
