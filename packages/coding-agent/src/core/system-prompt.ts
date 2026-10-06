import type { AgentTool } from "ZPI-agent";
import { formatSkillsForPrompt } from "./resources.ts";
import type { ResourceLoader } from "./types.ts";
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
export function buildSystemPrompt(options: {
  cwd: string;
  projectName?: string;
  platform?: string;
  template?: PromptTemplate;
  tools: Pick<AgentTool, "name" | "description" | "promptSnippet" | "promptGuidelines">[];
  loader?: ResourceLoader;
}): string {
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
  rules.push(
    ...renderTemplate(template.rules, context)
      .split("\n")
      .map((line) => line.replace(/^\s*-\s*/, ""))
      .filter(Boolean),
  );
  const sections = [
    options.loader?.getSystemPrompt() ?? renderTemplate(template.preamble, context),
    `<tools>\n${options.tools.map((t) => `- ${t.name}: ${t.promptSnippet ?? t.description}`).join("\n") || "(none)"}\n</tools>`,
    `<rules>\n${[...new Set(rules)].map((r) => `- ${r}`).join("\n")}\n</rules>`,
    ...(options.loader?.getAppendSystemPrompt() ?? []).filter((part) => !part.startsWith("<skills>")),
    ...(options.loader?.listSkills?.().skills.length &&
    options.tools.some((t) => ["read", "bash"].includes(t.name))
      ? [
          formatSkillsForPrompt(
            options.loader.listSkills().skills,
            options.tools.some((t) => t.name === "read") ? "read" : "bash",
          ),
        ]
      : []),
    `<cwd>\n${options.cwd.replace(/\\/g, "/")}\n</cwd>`,
  ];
  return sections.filter(Boolean).join("\n\n");
}
