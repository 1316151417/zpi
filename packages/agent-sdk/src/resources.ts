import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type LoadedSkill,
  parseMarkdownFrontmatter,
  type ResourceLoader,
  readFileBounded,
  type SkillList,
} from "zpi-coding-agent";
import { sdkHome } from "./runtime.ts";
import type { Options } from "./types.ts";

/** SDK opt-in settings discovery; no project code or config executes during loading. */
export class SdkResources implements ResourceLoader {
  private instructions: string[] = [];
  private skills: LoadedSkill[] = [];
  private options: Options;
  private cwd: string;
  constructor(options: Options, cwd: string) {
    this.options = options;
    this.cwd = cwd;
  }
  getInstructions(): string[] {
    return [...this.instructions];
  }
  listSkills(): SkillList {
    return { skills: this.skills.map(({ body: _, ...metadata }) => metadata), diagnostics: [] };
  }
  async loadSkill(name: string): Promise<LoadedSkill> {
    const skill = this.skills.find((skill) => skill.name === name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return structuredClone(skill);
  }
  async reload(): Promise<void> {
    this.instructions = [];
    this.skills = [];
    const sources = this.options.settingSources ?? [];
    const roots = [
      ...(sources.includes("user")
        ? [{ path: join(sdkHome(this.options), ".claude"), source: "user" as const }]
        : []),
      ...(sources.includes("project") || sources.includes("local")
        ? [{ path: join(this.cwd, ".claude"), source: "project" as const }]
        : []),
    ];
    const files = [
      ...roots.map((root) => join(root.path, "CLAUDE.md")),
      ...(sources.includes("project") ? [join(this.cwd, "CLAUDE.md"), join(this.cwd, "AGENTS.md")] : []),
      ...(sources.includes("local") ? [join(this.cwd, "CLAUDE.local.md")] : []),
    ];
    for (const path of files) {
      const value = await boundedText(path);
      if (value !== undefined)
        this.instructions.push(
          `<project_instructions path=${JSON.stringify(path)}>\n${value}\n</project_instructions>`,
        );
    }
    for (const root of roots) {
      const directory = join(root.path, "skills");
      const entries = await readdir(directory, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const path = join(directory, entry.name, "SKILL.md"),
          content = await boundedText(path);
        if (!content) continue;
        const parsed = parseMarkdownFrontmatter(content);
        if (!parsed) throw new Error(`Skill is missing frontmatter: ${path}`);
        const metadata = parsed.fields;
        const name = metadata.name === undefined ? entry.name : metadata.name;
        if (
          typeof name !== "string" ||
          !/^[A-Za-z0-9_.-]+$/.test(name) ||
          typeof metadata.description !== "string" ||
          !metadata.description.trim()
        )
          throw new Error(`Invalid skill metadata: ${path}`);
        if (this.options.skills && this.options.skills !== "all" && !this.options.skills.includes(name))
          continue;
        this.skills = this.skills.filter((skill) => skill.name !== name);
        this.skills.push({
          name,
          description: metadata.description,
          path,
          baseDir: join(directory, entry.name),
          source: root.source,
          body: parsed.body,
        });
      }
    }
  }
}
async function boundedText(path: string): Promise<string | undefined> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new Error(`Instruction/skill file is invalid or exceeds 1 MiB: ${path}`);
  return (await readFileBounded(path, 1024 * 1024)).toString("utf8");
}

/** Agent markdown is data; execution still goes through the SDK's registered tools. */
export function pluginAgents(
  snapshot: import("zpi-coding-agent").PluginSnapshot,
): Record<string, import("./types.ts").AgentDefinition> {
  const result: Record<string, import("./types.ts").AgentDefinition> = {};
  const definitions = snapshot.options?.agents;
  if (!Array.isArray(definitions)) throw new Error(`Invalid plugin agent catalog: ${snapshot.name}`);
  for (const definition of definitions) {
    if (
      !definition ||
      typeof definition !== "object" ||
      Array.isArray(definition) ||
      typeof definition.markdown !== "string"
    )
      throw new Error("Invalid plugin agent definition");
    const parsed = parseMarkdownFrontmatter(definition.markdown);
    if (!parsed) throw new Error("Agent definition requires YAML frontmatter");
    const fields = parsed.fields;
    if (typeof fields.description !== "string") throw new Error("Invalid plugin agent metadata");
    const list = (value: unknown): string[] | undefined => {
      if (value === undefined) return;
      const values = typeof value === "string" ? value.split(",").map((name) => name.trim()) : value;
      if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || !item))
        throw new Error("Invalid agent tools");
      return values;
    };
    const name = fields.name ?? definition.name;
    if (typeof name !== "string" || !name || (typeof fields.model !== "string" && fields.model !== undefined))
      throw new Error("Invalid agent name/model");
    result[`${snapshot.name}:${name}`] = {
      description: fields.description,
      prompt: parsed.body,
      tools: list(fields.tools),
      disallowedTools: list(fields.disallowedTools),
      model: fields.model === "inherit" ? undefined : fields.model,
    };
  }
  return result;
}
