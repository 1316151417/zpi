// Profile scopes, built-in identities and model overrides follow ZCode (Apache-2.0).
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { isJsonObject } from "zpi-ai";
import type { CombinedSelection } from "../../../shared/bridge.ts";
import type { SubagentCatalog, SubagentConfig, SubagentProfile } from "../../../shared/subagents.ts";
import { agentColors } from "../../../shared/subagents.ts";
import { atomicJson } from "../../storage.ts";
import { buildExploreAgentPrompt, buildGeneralPurposeSystemPrompt } from "./built-in.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
function markdownSelection(fields: Record<string, unknown>): CombinedSelection | undefined {
  if (typeof fields.model !== "string") return fields.modelSelection as CombinedSelection | undefined;
  const value = fields.model.trim();
  if (!value || ["inherit", "main", "sonnet", "opus", "haiku"].includes(value)) return undefined;
  let provider: string;
  let modelId: string;
  let reasoning = "";
  if (value.startsWith("custom:")) {
    const parts = value.slice(7).split(":");
    if (parts.length !== 2) return undefined;
    [provider, modelId] = parts.map(decodeURIComponent);
  } else {
    const index = value.indexOf("/");
    if (index < 1 || index === value.length - 1) return undefined;
    provider = value.slice(0, index);
    modelId = value.slice(index + 1);
    const effort = modelId.indexOf("$");
    if (effort > 0 && effort < modelId.length - 1) {
      reasoning = modelId.slice(effort + 1);
      modelId = modelId.slice(0, effort);
    }
  }
  return {
    provider,
    modelId,
    reasoning: typeof fields.thoughtLevel === "string" ? fields.thoughtLevel.trim() : reasoning,
  };
}
function markdownModel(selection: CombinedSelection) {
  return selection.provider.startsWith("custom:") ||
    selection.provider.includes("/") ||
    selection.modelId.includes("$")
    ? `custom:${encodeURIComponent(selection.provider)}:${encodeURIComponent(selection.modelId)}`
    : `${selection.provider}/${selection.modelId}`;
}
function toolNames(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const values = typeof value === "string" ? value.split(",").map((tool) => tool.trim()) : value;
  if (!Array.isArray(values) || values.some((tool) => typeof tool !== "string"))
    throw new Error("工具列表无效");
  return values.map((tool) => (["Read", "Write", "Edit", "Bash"].includes(tool) ? tool.toLowerCase() : tool));
}
export function validateSubagentConfig(value: unknown): asserts value is SubagentConfig {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !/^[a-zA-Z0-9-]{3,50}$/.test(value.name) ||
    typeof value.description !== "string" ||
    !value.description.trim() ||
    value.description.length > 8000 ||
    typeof value.systemPrompt !== "string" ||
    !value.systemPrompt.trim() ||
    value.systemPrompt.length > 100000 ||
    !agentColors.includes(value.color as SubagentConfig["color"]) ||
    typeof value.injectAgentsMd !== "boolean" ||
    (value.tools !== undefined &&
      (!Array.isArray(value.tools) ||
        value.tools.some((tool) => typeof tool !== "string" || !tool.trim()))) ||
    (value.disallowedTools !== undefined &&
      (!Array.isArray(value.disallowedTools) ||
        value.disallowedTools.some((tool) => typeof tool !== "string" || !tool.trim()))) ||
    (value.modelSelection !== undefined &&
      (!isRecord(value.modelSelection) ||
        ["provider", "modelId", "reasoning"].some(
          (key) => typeof (value.modelSelection as Record<string, unknown>)[key] !== "string",
        )))
  )
    throw new Error(
      "invalid_input: 子智能体配置无效（名称为 3–50 位字母、数字或连字符，描述和提示词不能为空）",
    );
}

export class SubagentProfiles {
  private state: { disabled: string[]; overrides: Record<string, SubagentConfig["modelSelection"]> };
  private statePath: string;
  private root: string;
  constructor(root: string) {
    this.root = root;
    this.statePath = join(root, "agents-state.json");
    this.state = { disabled: [], overrides: {} };
    this.reloadState();
  }
  private reloadState() {
    if (existsSync(this.statePath)) {
      const state = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (
        !isJsonObject(state) ||
        !Array.isArray(state.disabled) ||
        state.disabled.some((id) => typeof id !== "string") ||
        !isJsonObject(state.overrides)
      )
        throw new Error("storage: 子智能体状态无效");
      this.state = state as unknown as typeof this.state;
    } else this.state = { disabled: [], overrides: {} };
  }
  private directory(scope: "user" | "workspace", cwd?: string) {
    if (scope === "workspace" && !cwd) throw new Error("invalid_input: 请先选择项目");
    return scope === "workspace" ? join(cwd as string, ".zpi", "agents") : join(this.root, "agents");
  }
  list(cwd?: string): SubagentCatalog {
    this.reloadState();
    const agents: SubagentProfile[] = (
      [
        {
          id: "built-in:general-purpose",
          name: "general-purpose",
          scope: "built-in",
          enabled: true,
          color: "blue",
          injectAgentsMd: true,
          tools: ["*"],
          description:
            "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
          systemPrompt: buildGeneralPurposeSystemPrompt(),
        },
        {
          id: "built-in:Explore",
          name: "Explore",
          scope: "built-in",
          enabled: true,
          color: "cyan",
          injectAgentsMd: false,
          tools: ["read", "bash"],
          description:
            'Read-only search agent for broad fan-out searches - when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn\'t review or audit it. Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions.',
          systemPrompt: buildExploreAgentPrompt({ embeddedSearchEnabled: true }),
        },
      ] satisfies SubagentProfile[]
    ).map((agent) => ({ ...agent, modelSelection: this.state.overrides[agent.id] }));
    const diagnostics: SubagentCatalog["diagnostics"] = [];
    for (const scope of ["user", ...(cwd ? (["workspace"] as const) : [])] as const) {
      const dir = this.directory(scope, cwd);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).sort()) {
        if (!/\.(md|markdown)$/i.test(file)) continue;
        const path = join(dir, file);
        try {
          if (!statSync(path).isFile()) continue;
          const text = readFileSync(path, "utf8");
          if (text.length > 128000) throw new Error("配置文件过大");
          const match = frontmatter.exec(text);
          if (!match) throw new Error("缺少 YAML frontmatter");
          const doc = parseDocument(match[1], { uniqueKeys: true });
          if (doc.errors.length) throw new Error(doc.errors[0].message);
          const fields = doc.toJS({ maxAliasCount: 20 });
          if (!isJsonObject(fields)) throw new Error("frontmatter 必须是对象");
          const config = {
            ...fields,
            modelSelection: markdownSelection(fields),
            tools: toolNames(fields.tools),
            disallowedTools: toolNames(fields.disallowedTools),
            color: fields.color ?? "blue",
            injectAgentsMd: fields.injectAgentsMd ?? true,
            systemPrompt: text.slice(match[0].length).trim(),
          };
          validateSubagentConfig(config);
          const id = `${scope}:${file.replace(/\.(md|markdown)$/i, "")}`;
          agents.push({ ...config, id, path, scope, enabled: !this.state.disabled.includes(id) });
        } catch (error) {
          diagnostics.push({ path, message: String(error) });
        }
      }
    }
    return { agents, diagnostics };
  }
  save(config: SubagentConfig, scope: "user" | "workspace", id?: string, cwd?: string) {
    validateSubagentConfig(config);
    const catalog = this.list(cwd);
    const previous = id ? catalog.agents.find((agent) => agent.id === id) : undefined;
    if (id && !previous) throw new Error("not_found: 子智能体不存在");
    if (previous?.scope === "built-in") {
      if (
        ["name", "description", "systemPrompt", "color", "injectAgentsMd"].some(
          (key) => config[key as keyof SubagentConfig] !== previous[key as keyof SubagentConfig],
        ) ||
        JSON.stringify(config.tools) !== JSON.stringify(previous.tools)
      )
        throw new Error("invalid_input: 内置子智能体仅支持修改模型");
      const state = {
        ...this.state,
        overrides: { ...this.state.overrides, [id as string]: structuredClone(config.modelSelection) },
      };
      atomicJson(this.statePath, state);
      this.state = state;
      return this.list(cwd);
    }
    if (scope !== "user" && scope !== "workspace") throw new Error("invalid_input: 无效作用域");
    if (previous && previous.scope !== scope) throw new Error("invalid_input: 不能移动已保存的子智能体");
    if (
      catalog.agents.some(
        (agent) =>
          agent.scope === scope && agent.id !== id && agent.name.toLowerCase() === config.name.toLowerCase(),
      )
    )
      throw new Error("invalid_input: 子智能体名称已存在或为保留名称");
    const dir = this.directory(scope, cwd);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${config.name}.md`);
    const { systemPrompt, modelSelection, ...edited } = config;
    const priorMatch = previous?.path ? frontmatter.exec(readFileSync(previous.path, "utf8")) : null;
    const original = priorMatch ? parseDocument(priorMatch[1]).toJS({ maxAliasCount: 20 }) : {};
    const fields = {
      ...original,
      ...edited,
      model: modelSelection ? markdownModel(modelSelection) : "inherit",
    };
    for (const key of ["modelSelection", "id", "scope", "enabled", "path", "thoughtLevel", "systemPrompt"])
      delete fields[key];
    if (modelSelection?.reasoning) fields.thoughtLevel = modelSelection.reasoning;
    if (!config.tools) delete fields.tools;
    writeFileSync(`${path}.tmp`, `---\n${stringify(fields)}---\n\n${systemPrompt}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    if (previous?.path && previous.path !== path) {
      rmSync(previous.path);
      this.state.disabled = this.state.disabled.map((key) => (key === id ? `${scope}:${config.name}` : key));
      atomicJson(this.statePath, this.state);
    }
    return this.list(cwd);
  }
  delete(id: string, cwd?: string) {
    const agent = this.list(cwd).agents.find((agent) => agent.id === id);
    if (!agent?.path || agent.scope === "built-in") throw new Error("invalid_input: 此子智能体不可删除");
    rmSync(agent.path);
    this.state.disabled = this.state.disabled.filter((key) => key !== id);
    atomicJson(this.statePath, this.state);
    return this.list(cwd);
  }
  enable(id: string, enabled: boolean, cwd?: string) {
    const agent = this.list(cwd).agents.find((agent) => agent.id === id);
    if (agent?.scope !== "user" || typeof enabled !== "boolean")
      throw new Error("invalid_input: 此子智能体不可切换");
    const state = { ...this.state, disabled: this.state.disabled.filter((key) => key !== id) };
    if (!enabled) state.disabled.push(id);
    atomicJson(this.statePath, state);
    this.state = state;
    return this.list(cwd);
  }
}
