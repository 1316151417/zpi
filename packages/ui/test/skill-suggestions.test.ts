import { expect, it } from "vitest";
import { filterSkillSuggestions } from "../src/components/skill-suggestions.ts";
import type { InputSuggestion } from "../src/types.ts";

const skill = (name: string, description = "用户 · Skill description"): InputSuggestion => ({
  name,
  description,
  insert: `[$${name}](/skills/${name}/SKILL.md) `,
  group: "Skill",
});

it("ranks skill names before descriptions, supports case-insensitive subsequences and keeps stable ties", () => {
  const suggestions = [
    skill("other", "工作区 · Review sources"),
    skill("code-review"),
    skill("review-code"),
    skill("review-docs"),
    { name: "review", description: "Review", insert: "/review ", group: "命令" as const },
  ];
  expect(filterSkillSuggestions(suggestions, " REVIEW ").map((item) => item.name)).toEqual([
    "review-code",
    "review-docs",
    "code-review",
    "other",
  ]);
  expect(filterSkillSuggestions(suggestions, "crvw").map((item) => item.name)).toEqual(["code-review"]);
  expect(filterSkillSuggestions(suggestions, "missing")).toEqual([]);
});

it("matches contiguous Chinese descriptions without matching scattered Chinese characters", () => {
  const suggestions = [skill("browser", "用户 · 浏览器操作")];
  expect(filterSkillSuggestions(suggestions, "浏览器")).toEqual(suggestions);
  expect(filterSkillSuggestions(suggestions, "浏器")).toEqual([]);
});

it("keeps catalog order for an empty query and caps large catalogs like ZCode", () => {
  const suggestions = Array.from({ length: 1005 }, (_, i) => skill(`review-${i}`));
  expect(filterSkillSuggestions(suggestions, " ")).toEqual(suggestions.slice(0, 1000));
  expect(filterSkillSuggestions(suggestions, "review")).toHaveLength(1000);
});
