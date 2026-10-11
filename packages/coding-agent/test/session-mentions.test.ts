import { expect, it } from "vitest";
import {
  buildMentionMarkdown,
  buildSessionMentionMarkdown,
  extractSessionReferences,
  parseMentions,
} from "../src/core/mentions.ts";

const id = "d3bd8002-32ab-4fb9-b3a7-b8091f1f567a";
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
