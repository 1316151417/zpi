import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  buildSystemPrompt,
  createCodingTools,
  createPiTemplate,
  FileResourceLoader,
  piTemplate,
  renderTemplate,
  StaticResourceLoader,
  validateTemplate,
} from "../src/index.ts";
import { temp } from "./helpers/workspace-fixture.ts";

test("Pi prompt facts, literal nonrecursive variables, custom rules replace default, dynamic project sources", async () => {
  const cwd = await temp(),
    agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  await writeFile(join(cwd, "AGENTS.md"), "PROJECT RULE");
  const loader = new FileResourceLoader({ projectDir: cwd, homeDir: agentDir });
  await loader.reload();
  const prompt = buildSystemPrompt({ cwd, tools: createCodingTools(cwd), loader });
  expect(prompt.startsWith(piTemplate.preamble)).toBe(true);
  expect(prompt).toContain("operating inside ZPI,");
  expect(prompt).toContain("inspect ZPI_* environment variables");
  expect(prompt).not.toMatch(/\bPI_\*|operating inside pi,/);
  expect(prompt).toContain("Use bash for file operations like ls, rg, find");
  expect(prompt).toContain("Use read to examine files instead of cat or sed.");
  expect(prompt).toContain(`<project_instructions path="${join(cwd, "AGENTS.md")}">`);
  expect(prompt).toContain("<cwd>");
  expect(prompt).not.toMatch(/<docs>|Pi documentation/);
  const custom = {
    id: "custom",
    name: "Mine",
    preamble: "{{cwd}} {{project_name}} {{platform}} {literal}",
    rules: "CUSTOM ONLY",
  };
  expect(
    renderTemplate(custom.preamble, { cwd: "{{project_name}}", project_name: "P", platform: "darwin" }),
  ).toBe("{{project_name}} P darwin {literal}");
  expect(() => validateTemplate({ ...custom, rules: "{{unknown}}" })).toThrow("未知占位符");
  const changed = buildSystemPrompt({
    cwd,
    projectName: "Project",
    template: custom,
    tools: createCodingTools(cwd),
    loader,
  });
  expect(changed).toContain("CUSTOM ONLY");
  expect(changed).not.toContain("Be concise in your responses");
  expect(changed).toContain("PROJECT RULE");
  expect(changed).toContain("Use write only for new files or complete rewrites.");
});

test("custom instructions preserve legacy prompt ordering and literal base instructions", () => {
  const cwd = "/project";
  const tools = createCodingTools(cwd);
  const instructions = ["<project_context>PROJECT</project_context>"];
  const additions = ["<system_rules>DESKTOP</system_rules>", "CHILD {{cwd}}"];
  const baseInstructions = "Literal {{cwd}}";
  const legacy = buildSystemPrompt({
    cwd,
    tools,
    loader: {
      getSystemPrompt: () => baseInstructions,
      getAppendSystemPrompt: () => [...instructions, ...additions],
    },
  });
  const current = buildSystemPrompt({
    cwd,
    tools,
    loader: new StaticResourceLoader({ baseInstructions, instructions }),
    customInstructions: additions,
  });
  expect(current).toBe(legacy);
  expect(current.startsWith("Literal {{cwd}}\n\n<tools>")).toBe(true);
  expect(current.indexOf("PROJECT")).toBeLessThan(current.indexOf("DESKTOP"));
  expect(current.indexOf("CHILD {{cwd}}")).toBeLessThan(current.indexOf("<cwd>"));
  expect(
    buildSystemPrompt({ cwd, tools, loader: new StaticResourceLoader(baseInstructions, instructions) }),
  ).toBe(
    buildSystemPrompt({ cwd, tools, loader: new StaticResourceLoader({ baseInstructions, instructions }) }),
  );
});

test("new resource methods take precedence even when clearing legacy instructions", () => {
  const options = { cwd: "/project", tools: [] };
  expect(
    buildSystemPrompt({
      ...options,
      loader: {
        getBaseInstructions: () => undefined,
        getInstructions: () => [],
        getSystemPrompt: () => "LEGACY BASE",
        getAppendSystemPrompt: () => ["LEGACY APPEND"],
      },
    }),
  ).toBe(buildSystemPrompt(options));
});

test("custom instructions are literal additions and reject invalid runtime values", () => {
  const options = { cwd: "/project", tools: [] };
  expect(
    buildSystemPrompt({ ...options, customInstructions: ["<skills>literal</skills>", "{{unknown}}"] }),
  ).toContain("<skills>literal</skills>\n\n{{unknown}}\n\n<cwd>");
  for (const invalid of ["text", [1], null])
    expect(() => buildSystemPrompt({ ...options, customInstructions: invalid as never })).toThrow(
      "customInstructions must be an array of strings",
    );
});

test("default Pi template and generated prompt remain byte-for-byte stable", () => {
  const preamble =
    "You are an expert coding assistant operating inside ZPI, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
  const expected = {
    id: "pi",
    name: "ZPI 通用",
    preamble,
    rules: "Be concise in your responses\nShow file paths clearly when working with files",
  };
  expect(piTemplate).toEqual(expected);
  expect(createPiTemplate()).toEqual(expected);
  expect(createPiTemplate({ writable: true })).toEqual(expected);
  expect(buildSystemPrompt({ cwd: "/project", tools: [] })).toBe(
    `${preamble}\n\n<tools>\n(none)\n</tools>\n\n<rules>\n- Be concise in your responses\n- Show file paths clearly when working with files\n</rules>\n\n<cwd>\n/project\n</cwd>`,
  );
});

test("read-only Pi variant reuses the base template without advertising file changes", () => {
  const template = createPiTemplate({ writable: false });
  expect(template.preamble).toBe(
    "You are an expert coding assistant operating inside ZPI, a coding agent harness. You help users by reading files and executing commands.",
  );
  expect(template.rules).toBe(piTemplate.rules);
  expect(template.id).toBe(piTemplate.id);
  expect(template.name).toBe(piTemplate.name);
  expect(template.preamble).not.toMatch(/editing code|writing new files/);
});
