import remarkParse from "remark-parse";
import { unified } from "unified";
import { expect, it } from "vitest";
import { spacedFileLinkRemarkPlugin } from "../src/markdown-link-nodes.ts";

const parser = unified()
  .use(remarkParse)
  .use(spacedFileLinkRemarkPlugin({ cwd: "/workspace" }));

it.each([
  "`[示例](/tmp/My Files/a.md)`",
  "```md\n[示例](/tmp/My Files/a.md)\n```",
  "    [示例](/tmp/My Files/a.md)",
  "\\[示例](/tmp/My Files/a.md)",
  "![图片](/tmp/My Files/a.png)",
  "[网页](https://example.com/My Files/a.md)",
  "[不完整](/tmp/My Files/a.md",
  "[跨行](/tmp/My\nFiles/a.md)",
  '[有歧义](/tmp/My Files/a.md "标题")',
  "[越界](../My Files/a.md)",
  "[嵌套]([示例](/tmp/My Files/a.md))",
])("leaves ambiguous or protected source unchanged: %s", (source) => {
  const tree = parser.parse(source);
  const original = structuredClone(tree);
  expect(parser.runSync(tree, source)).toEqual(original);
});

it("keeps standard titles and link destinations unchanged", () => {
  const source = '[标题](./a.md "My Files") [规范](</tmp/My Files/a.md>)';
  const tree = parser.parse(source);
  const original = structuredClone(tree);
  expect(parser.runSync(tree, source)).toEqual(original);
});

it("uses the preview document directory for relative file destinations", () => {
  const processor = unified()
    .use(remarkParse)
    .use(
      spacedFileLinkRemarkPlugin({
        cwd: "/workspace",
        documentPath: "/workspace/doc/current.md",
      }),
    );
  const source = "[文件](../My Files/a.md)";
  expect(processor.runSync(processor.parse(source), source)).toMatchObject({
    children: [{ children: [{ type: "link", url: "../My Files/a.md" }] }],
  });
});
