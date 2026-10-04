import { expect, test } from "vitest";
import { buildMentionMarkdown, parseInput, parseMentions } from "../src/index.ts";

test("canonical file and skill Markdown roundtrips escaped labels and paths and routes explicit skill input", () => {
  const file = buildMentionMarkdown("a [中文].txt", "/project/a (中文).txt");
  const skill = buildMentionMarkdown("$review", "/home/.agents/skills/review/SKILL.md");
  const mentions = parseMentions(`${file}\n${skill} task`);
  expect(mentions.map((m) => [m.kind, m.label, m.path])).toEqual([
    ["file", "a [中文].txt", "/project/a (中文).txt"],
    ["skill", "review", "/home/.agents/skills/review/SKILL.md"],
  ]);
  expect(parseInput(`${skill} task`)).toEqual({ kind: "skill", name: "review", task: "task" });
  expect(buildMentionMarkdown("fileName.txt", "/path/project/fileName.txt")).toBe(
    "[fileName.txt](/path/project/fileName.txt)",
  );
});
