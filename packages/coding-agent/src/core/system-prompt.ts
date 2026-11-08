import type { AgentTool } from "zpi-agent";
import { formatSkillsForPrompt } from "./resources.ts";
import { type ResourceLoader, resourceBaseInstructions, resourceInstructions } from "./types.ts";
export interface PromptTemplate {
  id: string;
  name: string;
  preamble: string;
  rules: string;
}
export const piTemplate: PromptTemplate = {
  id: "pi",
  name: "ZPI 通用",
  preamble:
    "You are an expert coding assistant operating inside ZPI, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
  rules: "Be concise in your responses\nShow file paths clearly when working with files",
};
export function validateTemplate(template: PromptTemplate): void {
  if (
    !template ||
    typeof template.id !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(template.id) ||
    typeof template.name !== "string" ||
    !template.name.trim() ||
    template.name.length > 200 ||
    typeof template.preamble !== "string" ||
    typeof template.rules !== "string" ||
    template.preamble.length + template.rules.length > 100000
  )
    throw new Error("invalid_input: 提示词模板无效");
  for (const match of `${template.preamble}\n${template.rules}`.matchAll(/{{([\s\S]*?)}}/g))
    if (!["cwd", "project_name", "platform"].includes(match[1].trim()))
      throw new Error(`invalid_input: 未知占位符 {{${match[1]}}}`);
}
export function renderTemplate(
  text: string,
  context: { cwd: string; project_name: string; platform: string },
): string {
  return text.replace(
    /{{\s*(cwd|project_name|platform)\s*}}/g,
    (_, key: keyof typeof context) => context[key],
  );
}
export interface SystemContext {
  base: string;
  sections: Record<string, string>;
}
export function buildSystemContext(options: {
  cwd: string;
  projectName?: string;
  platform?: string;
  template?: PromptTemplate;
  tools: readonly Pick<AgentTool, "name" | "description" | "promptSnippet" | "promptGuidelines">[];
  loader?: ResourceLoader;
  /** Literal instructions appended after resources, before the skill catalog and working directory. */
  customInstructions?: readonly string[];
  baseInstructions?: string;
}): SystemContext {
  if (
    options.customInstructions !== undefined &&
    (!Array.isArray(options.customInstructions) ||
      options.customInstructions.some((part) => typeof part !== "string"))
  )
    throw new Error("invalid_input: customInstructions must be an array of strings");
  const template = options.template ?? piTemplate;
  validateTemplate(template);
  const context = {
    cwd: options.cwd,
    project_name: options.projectName ?? "ZPI",
    platform: options.platform ?? process.platform,
  };
  const rules: string[] = [];
  if (
    options.tools.some((t) => t.name === "bash") &&
    !options.tools.some((t) => ["grep", "find", "ls"].includes(t.name))
  )
    rules.push("Use bash for file operations like ls, rg, find");
  for (const tool of options.tools) rules.push(...(tool.promptGuidelines ?? []));
  const baseRules = renderTemplate(template.rules, context)
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, ""))
    .filter(Boolean);
  const toolSnippets = options.tools
    .filter((tool) => ["read", "write", "edit", "bash"].includes(tool.name) && tool.promptSnippet)
    .map((tool) => `- ${tool.name}: ${tool.promptSnippet}`);
  const skills = options.loader?.listSkills?.().skills ?? [];
  const skillTool = (["read", "Read", "Skill", "bash", "Bash"] as const).find((name) =>
    options.tools.some((tool) => tool.name === name),
  );
  const base =
    options.baseInstructions ??
    [
      resourceBaseInstructions(options.loader) ?? renderTemplate(template.preamble, context),
      `<rules>\n${[...new Set(baseRules)].map((r) => `- ${r}`).join("\n")}\n</rules>`,
    ]
      .filter(Boolean)
      .join("\n\n");
  const sections: Record<string, string> = {
    "zpi.tools": toolSnippets.length ? `<tools>\n${toolSnippets.join("\n")}\n</tools>` : "",
    "zpi.tool-rules": rules.length
      ? `<rules>\n${[...new Set(rules)].map((r) => `- ${r}`).join("\n")}\n</rules>`
      : "",
    "zpi.resources": resourceInstructions(options.loader)
      .filter((part) => !part.startsWith("<skills>"))
      .join("\n\n"),
    "zpi.custom": (options.customInstructions ?? []).join("\n\n"),
    "zpi.skills": skills.length && skillTool ? formatSkillsForPrompt(skills, skillTool) : "",
    "zpi.environment": `<cwd>\n${options.cwd.replace(/\\/g, "/")}\n</cwd>`,
  };
  return { base, sections };
}

/** Human-readable preview; model requests use the independently managed blocks. */
export function buildSystemPrompt(options: Parameters<typeof buildSystemContext>[0]): string {
  const { base, sections } = buildSystemContext(options);
  return [base, ...Object.values(sections)].filter(Boolean).join("\n\n");
}
