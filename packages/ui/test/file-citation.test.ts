import { describe, expect, it } from "vitest";
import {
  extractFileCitations,
  fileCitationRemarkPlugin,
  projectFileCitations,
} from "../src/file-citation.ts";
import { markdownLinkRemarkPlugin } from "../src/markdown-link-nodes.ts";

describe("file citation directives", () => {
  it("accepts canonical and compatible citation syntax, preserving Windows escapes", () => {
    for (const prefix of [":", "::", ":::"])
      expect(
        extractFileCitations(
          `${prefix}zcode-file-citation{path=“./订单 汇总.json” purpose='report' artifact_kind=workbook}`,
        )[0]?.path,
      ).toBe("./订单 汇总.json");
    expect(
      extractFileCitations('::zcode-file-citation{path="C:\\Users\\test\\.config\\file.json"}')[0]?.path,
    ).toBe("C:\\Users\\test\\.config\\file.json");
    for (const raw of [
      '::::zcode-file-citation{path="a.json"}',
      '::zcode-file-citation{purpose="x"}',
      '::zcode-file-citation{path=""}',
      '::zcode-file-citation{path="a.json" prose}',
    ])
      expect(extractFileCitations(raw)).toEqual([]);
  });
  it("hides unfinished streaming tails, keeps malformed continuations and code examples", () => {
    for (const tail of [
      "::",
      "::zcode-file",
      ":zcode",
      ":::zcode-file-citation",
      "::zcode-file-citation{",
      '::zcode-file-citation{path="a',
      '::zcode-file-citation{path="a.json"',
      '::zcode-file-citation{path="a.json" purpose=',
    ]) {
      expect(projectFileCitations(`before ${tail}`, true), tail).toBe("before ");
      expect(projectFileCitations(`before ${tail}`, false)).toBe(`before ${tail}`);
    }
    const malformed = 'before ::zcode-file-citation{path="a.json"\nordinary prose follows';
    expect(projectFileCitations(malformed, true)).toBe(malformed);
    for (const raw of [
      '`::zcode-file-citation{path="x"`',
      '`::zcode-file-citation{path="x',
      '```text\n::zcode-file-citation{path="x"\n```',
      '~~~text\n::zcode-file-citation{path="x"',
      '<code>::zcode-file-citation{path="x"</code>',
      'Example:\n\n    ::zcode-file-citation{path="x',
      '\t::zcode-file-citation{path="x',
      '```text\n``` not a closing fence\n::zcode-file-citation{path="x',
      '````text\n```\n::zcode-file-citation{path="x',
    ])
      expect(projectFileCitations(raw, true)).toBe(raw);
    const block = "Example:\n\n    `literal code\n\nReference: ";
    expect(projectFileCitations(`${block}::zcode-file-citation{path="file`, true)).toBe(block);
  });
  it("creates ordinary link nodes only for valid citations outside code and links", () => {
    const literal = '::zcode-file-citation{path="./订单.json:2:4"}';
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: `File ${literal}; README.md /tmp/file.txt` }],
        },
        ...["code", "inlineCode", "html", "link"].map((type) => ({
          type,
          children: [{ type: "text", value: literal }],
        })),
      ],
    };
    fileCitationRemarkPlugin({ cwd: "/project" })()(tree, "");
    expect(tree.children[0].children).toEqual([
      { type: "text", value: "File " },
      { type: "link", url: "./订单.json:2:4", children: [{ type: "text", value: "订单.json" }] },
      { type: "text", value: "; README.md /tmp/file.txt" },
    ]);
    for (const node of tree.children.slice(1)) expect(node.children[0].value).toBe(literal);
  });
});
it("restores Windows destinations lost through CommonMark punctuation escapes", () => {
  const source = "[config](C:\\Users\\test\\.config\\file.json)";
  const node = {
    type: "link",
    url: "C:\\Users\\test.config\\file.json",
    position: { start: { offset: 0 }, end: { offset: source.length } },
  };
  const plugin = markdownLinkRemarkPlugin as () => (tree: unknown, file: unknown) => void;
  plugin()({ type: "root", children: [node] }, source);
  expect(node.url).toBe("C:\\Users\\test\\.config\\file.json");
});

it("uses the original citation path when CommonMark removes punctuation escapes", () => {
  const source = 'Reference ::zcode-file-citation{path="C:\\Users\\test\\.config\\a.json"}';
  const tree = {
    type: "root",
    children: [
      {
        type: "text",
        value: source.replace("\\.config", ".config"),
        position: { start: { offset: 0 }, end: { offset: source.length } },
      },
    ],
  };
  fileCitationRemarkPlugin({})()(tree, source);
  expect(tree.children).toEqual([
    { type: "text", value: "Reference " },
    { type: "link", url: "C:\\Users\\test\\.config\\a.json", children: [{ type: "text", value: "a.json" }] },
  ]);
});

it("preserves angle-bracket Windows paths with spaces without rewriting other links", () => {
  const source = "[config](<C:\\My Files\\.config\\a.json>)";
  const node = {
    type: "link",
    url: "C:\\My Files.config\\a.json",
    position: { start: { offset: 0 }, end: { offset: source.length } },
  };
  const plugin = markdownLinkRemarkPlugin as () => (tree: unknown, file: unknown) => void;
  plugin()({ type: "root", children: [node] }, source);
  expect(node.url).toBe("C:\\My Files\\.config\\a.json");
});

it("recovers reference definitions and entities with the same Windows destination rules", () => {
  const source = "[config][cfg]\n\n[cfg]: <C:\\My Files\\.config\\a&amp;b.json>";
  const definition = {
    type: "definition",
    identifier: "cfg",
    url: "C:\\My Files.config\\a&b.json",
    position: { start: { offset: source.indexOf("[cfg]:") }, end: { offset: source.length } },
  };
  const reference = { type: "linkReference", identifier: "cfg", data: { hProperties: {} } };
  const plugin = markdownLinkRemarkPlugin as () => (tree: unknown, file: unknown) => void;
  plugin()({ type: "root", children: [reference, definition] }, source);
  expect(definition.url).toBe("C:\\My Files\\.config\\a&b.json");
  expect(reference.data.hProperties).toEqual({ dataZpiTarget: definition.url });
});
