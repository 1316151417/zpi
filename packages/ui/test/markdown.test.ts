import { describe, expect, it } from "vitest";
import { normalizeMath } from "../src/components/markdown-math.ts";
import { tableCsv, tableMarkdown } from "../src/components/markdown-table-text.ts";

describe("Markdown table export", () => {
  it("preserves columns, pipes, backslashes and multiline cells", () => {
    expect(tableMarkdown([["Name", "Value"], ["a|b", "c\\d\ne"], ["last"]])).toBe(
      "| Name | Value |\n| --- | --- |\n| a\\|b | c\\\\d<br>e |\n| last |  |",
    );
    expect(tableMarkdown([])).toBe("");
  });
  it("exports Chinese UTF-8 CSV and quotes commas, newlines and spreadsheet formulas", () => {
    expect(
      tableCsv([
        ["名称", "内容"],
        ["a,b", '"quoted"\nline'],
        [" =SUM(A1)", "@command"],
      ]),
    ).toBe('\uFEFF名称,内容\r\n"a,b","""quoted""\nline"\r\n\' =SUM(A1),\'@command');
    for (const value of ["+1", "-1", "\tformula", "\rformula", "\nformula"])
      expect(tableCsv([[value]])).toContain(`'${value}`);
  });
});

describe("inline math", () => {
  it("renders math without treating prices and environment variables as formulas", () => {
    expect(normalizeMath("$x^2$ and $\\alpha$; $5 to $10; $HOME and $PATH")).toBe(
      "$x^2$ and $\\alpha$; \\$5 to \\$10; \\$HOME and $PATH",
    );
    expect(normalizeMath("$5-$10")).toBe("\\$5-$10");
  });
  it("leaves escaped dollars, code spans, fenced code and display math intact", () => {
    const text = "`$HOME $PATH` \\$5\n```sh\necho $HOME $PATH\n```\n$$x^2$$\n$x$";
    expect(normalizeMath(text)).toBe(text);
  });
  it("keeps code literal until a matching closing fence without trailing text", () => {
    for (const code of [
      "```text\n``` not a closing fence\n$HOME $PATH\n```",
      "````sh\n```\n$HOME $PATH\n````",
      "~~~sh\n```\n$HOME $PATH\n~~~",
      "    echo $HOME $PATH\n\techo $HOME $PATH",
    ])
      expect(normalizeMath(`${code}\n\n$5 to $10`)).toBe(`${code}\n\n\\$5 to $10`);
  });
});
