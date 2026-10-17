import { expect, it } from "vitest";
import {
  buildMentionMarkdown,
  buildSessionMentionMarkdown,
  extractSessionReferences,
  parseMentions,
} from "../src/core/mentions.ts";

const id = "d3bd8002-32ab-4fb9-b3a7-b8091f1f567a";

it("keeps backticks inside link labels and destinations as part of the mention", () => {
  const path = "/workspace/file`name.ts";
  expect(parseMentions(buildMentionMarkdown("file`name.ts", path))).toMatchObject([{ path }]);
  expect(parseMentions("[`label`](./file.ts)")).toMatchObject([{ path: "./file.ts" }]);
});

it.each(["C:\\work\\project\\main.ts", "D:/work/file with spaces.ts", "\\\\server\\share\\main.ts"])(
  "roundtrips Windows file and skill references: %s",
  (path) => {
    for (const [label, kind] of [
      ["main.ts", "file"],
      ["$review", "skill"],
    ]) {
      expect(parseMentions(buildMentionMarkdown(label, path))).toMatchObject([{ kind, path }]);
    }
  },
);

it.each([
  "```markdown\n%s\n```",
  "~~~markdown\r\n%s\r\n~~~",
  "    %s",
  "`%s`",
  "``%s``",
  "<pre>%s</pre>",
  "```markdown\n%s",
])("ignores file, skill and session mentions inside code: %s", (template) => {
  const example = `[file](./missing.ts) [$review](/missing/SKILL.md) [task](#${id}) #${id}`;
  const quoted = template.replace("%s", example);
  expect(parseMentions(quoted)).toEqual([]);
  expect(parseMentions(`[actual](./actual.ts)\n${quoted}`)).toMatchObject([{ path: "./actual.ts" }]);
});
it("roundtrips session identity independently of escaped display titles without treating it as a file", () => {
  const markdown = buildSessionMentionMarkdown(id, "标题 [括号] \\ 测试");
  expect(markdown).toBe(`[#标题 \\[括号\\] \\\\ 测试](#${id})`);
  expect(parseMentions(`前 ${markdown} 后`)).toEqual([
    {
      kind: "session",
      label: "标题 [括号] \\ 测试",
      path: `#${id}`,
      start: 2,
      end: 2 + markdown.length,
      markdown,
    },
  ]);
  expect(extractSessionReferences(`${markdown} #${id} #sess_old.1`)).toEqual([id, "sess_old.1"]);
  expect(buildSessionMentionMarkdown(id)).toBe(`#${id}`);
  expect(buildSessionMentionMarkdown(id, id)).toBe(`#${id}`);
});
it("keeps ordinary hash text and anchors intact and never extracts identities from labels or file paths", () => {
  const file = buildMentionMarkdown(`#${id}`, "/workspace/a.txt");
  expect(
    extractSessionReferences(
      `# Heading\n#heading [anchor](#section) ${file} [title #${id} rest](https://example.com)`,
    ),
  ).toEqual([]);
  expect(parseMentions(`prefix#${id} #${id}suffix`)).toEqual([]);
  expect(extractSessionReferences(`[#${id}](#sess_actual)`)).toEqual(["sess_actual"]);
});
