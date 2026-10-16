import { expect, it } from "vitest";
import {
  customCommandNames,
  slashSuggestionLabel,
  slashSuggestions,
  slashTokenEnd,
  subagentNames,
} from "../src/components/command-suggestions.ts";
import { displayReferences, referenceStyle } from "../src/components/Reference.tsx";
import type { InputSuggestion } from "../src/types.ts";

const command = (name: string, description = "", customCommand = true): InputSuggestion => ({
  name,
  description,
  customCommand,
  insert: `/${name} `,
  group: "命令",
});
const skill = (name: string): InputSuggestion => ({
  name,
  description: "Skill description",
  insert: `[$${name}](/skills/${name}/SKILL.md) `,
  group: "Skill",
});

it("preserves built-in/custom catalog order, groups skills after commands and excludes removed or unsupported commands", () => {
  const catalog = [
    command("init", "", false),
    command("compact", "", false),
    command("review"),
    command("side"),
    command("btw"),
    command("workflow", "", false),
    skill("writing"),
  ];
  expect(slashSuggestions(catalog, "").options.map((item) => item.name)).toEqual([
    "init",
    "compact",
    "review",
    "writing",
  ]);
  expect(customCommandNames(catalog)).toEqual(["init", "compact", "review"]);
});

it("uses stable fuzzy name/description/hint matching and selects the strongest result across groups", () => {
  const catalog = [command("audit", "Review sources"), command("code-review"), skill("review")];
  const result = slashSuggestions(catalog, " ReV ");
  expect(result.options.map((item) => item.name)).toEqual(["code-review", "audit", "review"]);
  expect(result.selectedIndex).toBe(2);
  expect(slashSuggestions(catalog, "crvw").options.map((item) => item.name)).toEqual(["code-review"]);
  expect(
    slashSuggestions([{ ...command("audit"), argumentHint: "[target scope]" }], "scope").commands,
  ).toHaveLength(1);
  expect(slashSuggestions(catalog, "missing").options).toEqual([]);
});

it("replaces only a matching unfinished suffix and preserves ordinary following text", () => {
  expect(slashTokenEnd("/review after", 4, "rev", "review")).toBe(7);
  expect(slashTokenEnd("/正文", 1, "", "review")).toBe(1);
  expect(slashTokenEnd("/rev正文", 4, "rev", "review")).toBe(4);
  expect(slashTokenEnd("/rev  after", 4, "rev", "review")).toBe(4);
});

it("renders only catalogued custom command chips with canonical slash text and a generic icon", () => {
  const text = "/review scope /tmp /side /btw /init /compact";
  const references = displayReferences(text, ["review", "side", "btw"]);
  expect(references.map((item) => item.markdown)).toEqual(["/review", "/init", "/compact"]);
  expect(references[0]).toMatchObject({ kind: "command", label: "review", path: "", start: 0, end: 7 });
  expect(displayReferences("/unknown")).toEqual([]);
  expect(displayReferences("/tools/review scope", ["tools/review"])[0]?.markdown).toBe("/tools/review");
  expect(displayReferences("/tools:review scope", ["tools/review"])[0]?.label).toBe("tools/review");
  expect(slashSuggestions([command("tools/review")], "tools:rev").commands).toHaveLength(1);
  for (const name of ["_review", "-review"])
    expect(displayReferences(`/${name}`, [name])[0]?.markdown).toBe(`/${name}`);
  expect(displayReferences("[file](/review)", ["review"])).toHaveLength(1);
  expect(
    String(referenceStyle("command", "review")["--mention-mask" as keyof React.CSSProperties]),
  ).toContain("data:image/svg+xml");
});

const agent = (name: string, description = "Workspace · Code review"): InputSuggestion => ({
  name,
  description,
  insert: `@${name} `,
  group: "子智能体",
});

it("keeps Commands, Skills and Subagents sections in order, including empty sections", () => {
  const catalog = [agent("Explore"), skill("review"), command("review"), agent("reviewer")];
  const result = slashSuggestions(catalog, "");
  expect(result.options.map((item) => item.group)).toEqual(["命令", "Skill", "子智能体", "子智能体"]);
  expect(result.sections.map(({ label, offset }) => ({ label, offset }))).toEqual([
    { label: "指令", offset: 0 },
    { label: "技能", offset: 1 },
    { label: "子智能体", offset: 2 },
  ]);
  expect(subagentNames(catalog)).toEqual(["Explore", "reviewer"]);
  expect(customCommandNames(catalog)).toEqual(["review"]);
  expect(result.options.map(slashSuggestionLabel)).toEqual(["/review", "$review", "Explore", "reviewer"]);
  const emptySkills = slashSuggestions([agent("Explore"), command("init", "", false)], "");
  expect(
    emptySkills.sections.map((section) => [section.label, section.offset, section.options.length]),
  ).toEqual([
    ["指令", 0, 1],
    ["技能", 1, 0],
    ["子智能体", 1, 1],
  ]);
  expect(slashSuggestions([], "").sections.map((section) => section.options)).toEqual([[], [], []]);
});

it("selects the strongest subagent match without changing group order or canonical insertion", () => {
  const result = slashSuggestions(
    [command("audit", "Review code"), skill("code-review"), agent("Review")],
    "rev",
  );
  expect(result.options.map((item) => item.name)).toEqual(["audit", "code-review", "Review"]);
  expect(result.selectedIndex).toBe(2);
  expect(result.options[result.selectedIndex].insert).toBe("@Review ");
  expect(slashSuggestions([agent("Explore")], "agent").subagents).toHaveLength(1);
  expect(slashTokenEnd("/Review rest", 4, "Rev", "Review")).toBe(7);
});

it("renders catalog-aware Bot chips without file semantics and preserves the canonical @ mention", () => {
  const text = "@Explore investigate @unknown user@example.com @Explore/path /review";
  const references = displayReferences(text, ["review"], ["Explore"]);
  expect(references.map((item) => item.markdown)).toEqual(["@Explore", "/review"]);
  expect(references[0]).toMatchObject({ kind: "subagent", label: "Explore", path: "", start: 0, end: 8 });
  expect(displayReferences("@explore", [], ["Explore"])[0]).toMatchObject({
    label: "Explore",
    markdown: "@explore",
    kind: "subagent",
  });
  expect(displayReferences("@Explore", [], [])).toEqual([]);
  expect(displayReferences("[quoted @Explore name](/file)", [], ["Explore"])).toHaveLength(1);
  expect(String(referenceStyle("subagent", "")["--mention-mask" as keyof React.CSSProperties])).toContain(
    "data:image/svg+xml",
  );
});
