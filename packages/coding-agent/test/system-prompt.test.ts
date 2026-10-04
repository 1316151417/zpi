import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  buildSystemPrompt,
  createCodingTools,
  FileResourceLoader,
  piTemplate,
  renderTemplate,
  validateTemplate,
} from "../src/index.ts";
import { temp } from "./helpers/workspace-fixture.ts";

test("Pi prompt facts, literal nonrecursive variables, custom rules replace default, dynamic project sources", async () => {
  const cwd = await temp(),
    agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  await writeFile(join(cwd, "AGENTS.md"), "PROJECT RULE");
  const loader = new FileResourceLoader({ userSkillPaths: [], cwd, agentDir });
  await loader.reload();
  const prompt = buildSystemPrompt({ cwd, tools: createCodingTools(cwd), loader });
  expect(prompt.startsWith(piTemplate.preamble)).toBe(true);
  expect(prompt).toContain("operating inside zpi,");
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
