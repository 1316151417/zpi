import { expect, test } from "vitest";
import { matchMarkdownFrontmatter, parseMarkdownFrontmatter } from "../src/core/markdown.ts";

test.each(["\n", "\r\n"])(
  "parses BOM and spaced fences with %j newlines without rewriting the body",
  (newline) => {
    const text = [
      "\uFEFF--- \t",
      "name: review",
      "description: Review code",
      "nested: {enabled: true}",
      "---\t ",
      "",
      "  Literal {{body}}  ",
      "",
    ].join(newline);
    const parsed = parseMarkdownFrontmatter(text);
    expect(parsed?.fields).toEqual({ name: "review", description: "Review code", nested: { enabled: true } });
    expect(parsed?.body).toBe("Literal {{body}}");
    expect(text.slice(parsed?.bodyOffset)).toBe(["", "  Literal {{body}}  ", ""].join(newline));
  },
);

test.each(["Plain Markdown", "---\ndescription: Unclosed", "# Intro\n---\nname: embedded\n---\nBody"])(
  "leaves frontmatter policy to the caller for %j",
  (text) => {
    expect(parseMarkdownFrontmatter(text)).toBeUndefined();
    expect(matchMarkdownFrontmatter(text)).toBeUndefined();
  },
);

test("matches a closed bounded prefix without requiring its body or parsing YAML", () => {
  const text = "---\ninvalid: [\n---\n";
  expect(matchMarkdownFrontmatter(text)?.bodyOffset).toBe(text.length);
  expect(() => parseMarkdownFrontmatter(text)).toThrow();
});

test.each(["name: first\nname: second", "- one\n- two", "null", "42", "loop: &loop {self: *loop}"])(
  "rejects duplicate keys and non-JSON mappings: %j",
  (yaml) => {
    expect(() => parseMarkdownFrontmatter(`---\n${yaml}\n---\nBody`)).toThrow();
  },
);

test("bounds YAML alias expansion", () => {
  const aliases = Array(25).fill("*item").join(", ");
  expect(() =>
    parseMarkdownFrontmatter(`---\nitem: &item [one, two]\nitems: [${aliases}]\n---\nBody`),
  ).toThrow();
});
