import { open, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import type { ResourceDiagnostic, ResourceLoader } from "./types.ts";

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  baseDir: string;
  source: "user" | "project" | "extra";
}
export interface DiscoveredSkill extends SkillMetadata {
  enabled: boolean;
  overriddenBy?: string;
}
export interface SkillPolicyOptions {
  cwd: string;
  agentDir: string;
  additionalSkillPaths?: string[];
  userSkillPaths?: string[];
  projectResources?: boolean;
  isSkillEnabled?: (path: string) => boolean;
}
export interface SkillList {
  skills: SkillMetadata[];
  diagnostics: ResourceDiagnostic[];
}
export interface LoadedSkill extends SkillMetadata {
  body: string;
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function frontmatter(text: string): { yaml: string; bodyOffset: number } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("SKILL.md requires closed YAML frontmatter");
  return { yaml: match[1], bodyOffset: match[0].length };
}
async function metadataText(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let offset = 0; offset < 65536; offset += 1024) {
      const buffer = Buffer.alloc(1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      text += decoder.decode(buffer.subarray(0, bytesRead), { stream: bytesRead !== 0 });
      if (/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) return text;
      if (bytesRead === 0) break;
    }
    throw new Error("Missing or oversized YAML frontmatter (limit 64 KiB)");
  } finally {
    await file.close();
  }
}
function parseMetadata(path: string, source: SkillMetadata["source"], text: string): SkillMetadata {
  const doc = parseDocument(frontmatter(text).yaml, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message).join("; "));
  const value: unknown = doc.toJS({ maxAliasCount: 20 });
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Skill metadata must be a mapping");
  const { name, description } = value as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
    name !== basename(dirname(path))
  )
    throw new Error("Skill name must match its directory and use lowercase letters, digits and hyphens");
  if (typeof description !== "string" || !description.trim() || description.length > 1024)
    throw new Error("Skill description must contain 1–1024 characters");
  return { name, description: description.trim(), path, baseDir: dirname(path), source };
}
export class SkillCatalog {
  private discovered: DiscoveredSkill[] = [];
  private winners: SkillMetadata[] = [];
  private catalog: SkillList = { skills: [], diagnostics: [] };
  constructor(privateOptions: SkillPolicyOptions) {
    this.options = privateOptions;
  }
  private options: SkillPolicyOptions;
  async reload(): Promise<void> {
    const skills = new Map<string, SkillMetadata>();
    const discovered: SkillMetadata[] = [];
    const diagnostics: ResourceDiagnostic[] = [];
    const roots: { path: string; source: SkillMetadata["source"] }[] = [
      ...(this.options.userSkillPaths ?? [join(homedir(), ".agents", "skills")]).map((path) => ({
        path,
        source: "user" as const,
      })),
      { path: join(this.options.agentDir, "skills"), source: "user" },
      ...(this.options.additionalSkillPaths ?? []).map((path) => ({
        path: resolve(path),
        source: "extra" as const,
      })),
      ...(this.options.projectResources === false
        ? []
        : [
            { path: join(this.options.cwd, ".agents", "skills"), source: "project" as const },
            { path: join(this.options.cwd, ".zpi", "skills"), source: "project" as const },
          ]),
    ];
    for (const root of roots) {
      try {
        const entries = await readdir(root.path, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const path = join(root.path, entry.name, "SKILL.md");
          try {
            const skill = parseMetadata(path, root.source, await metadataText(path));
            skill.path = await realpath(skill.path);
            discovered.push(skill);
            skills.set(skill.name, skill);
          } catch (e) {
            if (!missing(e)) diagnostics.push({ path, message: String(e) });
          }
        }
      } catch (e) {
        if (!missing(e)) diagnostics.push({ path: root.path, message: String(e) });
      }
    }
    this.winners = [...skills.values()];
    const lastByPath = new Map(discovered.map((skill, index) => [skill.path, index]));
    this.discovered = discovered
      .filter((skill, index) => lastByPath.get(skill.path) === index)
      .map((skill) => ({
        ...skill,
        enabled: this.options.isSkillEnabled?.(skill.path) !== false,
        ...(skills.get(skill.name)?.path !== skill.path
          ? { overriddenBy: skills.get(skill.name)?.path }
          : {}),
      }));
    this.catalog = {
      skills: this.winners.filter((skill) => this.options.isSkillEnabled?.(skill.path) !== false),
      diagnostics,
    };
  }
  listSkills(): SkillList {
    return structuredClone(this.catalog);
  }
  listDiscoveredSkills(): DiscoveredSkill[] {
    return structuredClone(this.discovered);
  }
  async loadSkill(name: string): Promise<LoadedSkill> {
    const winner = this.winners.find((s) => s.name === name);
    if (winner && !this.catalog.skills.some((s) => s.path === winner.path))
      throw new Error(`invalid_input: Skill disabled: ${name}`);
    const skill = this.catalog.skills.find((s) => s.name === name);
    if (!skill) throw new Error(`invalid_input: Skill not found: ${name}`);
    const text = await readFile(skill.path, "utf8");
    const current = parseMetadata(skill.path, skill.source, text);
    return { ...current, body: text.slice(frontmatter(text).bodyOffset).trim() };
  }
}
export class FileResourceLoader implements ResourceLoader {
  private options: SkillPolicyOptions;
  private catalog: SkillCatalog;
  private append: string[] = [];
  private diagnostics: ResourceDiagnostic[] = [];
  constructor(options: SkillPolicyOptions) {
    this.options = options;
    this.catalog = new SkillCatalog(options);
  }
  getSystemPrompt(): undefined {
    return undefined;
  }
  getAppendSystemPrompt(): string[] {
    return [...this.append];
  }
  async reload(): Promise<void> {
    const ancestors: string[] = [];
    let path = resolve(this.options.cwd);
    for (;;) {
      ancestors.unshift(join(path, "AGENTS.md"));
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
    const files = [
      ...new Set([
        join(this.options.agentDir, "AGENTS.md"),
        ...(this.options.projectResources === false ? [] : ancestors),
      ]),
    ];
    const append: string[] = [];
    const diagnostics: ResourceDiagnostic[] = [];
    for (const file of files) {
      try {
        append.push(
          `<project_instructions path="${xml(file)}">\n${await readFile(file, "utf8")}\n</project_instructions>`,
        );
      } catch (e) {
        if (!missing(e)) diagnostics.push({ path: file, message: String(e) });
      }
    }
    await this.catalog.reload();
    const skills = this.catalog.listSkills();
    diagnostics.push(...skills.diagnostics);
    if (append.length)
      append.splice(
        0,
        append.length,
        `<project_context>\nProject-specific instructions and guidelines:\n\n${append.join("\n\n")}\n</project_context>`,
      );
    if (skills.skills.length) append.push(formatSkillsForPrompt(skills.skills));
    this.append = append;
    this.diagnostics = diagnostics;
  }
  listSkills(): SkillList {
    return this.catalog.listSkills();
  }
  listDiscoveredSkills(): DiscoveredSkill[] {
    return this.catalog.listDiscoveredSkills();
  }
  loadSkill(name: string): Promise<LoadedSkill> {
    return this.catalog.loadSkill(name);
  }
  getDiagnostics(): ResourceDiagnostic[] {
    return structuredClone(this.diagnostics);
  }
}

function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
export function formatSkillsForPrompt(skills: SkillMetadata[], tool: "read" | "bash" = "read"): string {
  return [
    "<skills>",
    "The following skills provide specialized instructions for specific tasks.",
    tool === "read"
      ? "Use the read tool to load a skill's file when the task matches its description."
      : "Use bash to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    ...skills.flatMap((s) => [
      "  <skill>",
      `    <name>${xml(s.name)}</name>`,
      `    <description>${xml(s.description)}</description>`,
      `    <location>${xml(s.path)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
    "</skills>",
  ].join("\n");
}
