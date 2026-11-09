import type { JsonObject } from "@zpi-dev/ai";
import type { HookEvent, PluginSnapshot, SessionPlugin } from "@zpi-dev/coding-agent";

const communicationStyleRules = [
  "Before the first tool call, briefly state your next action; during work, report meaningful findings or changes in direction.",
  "End with a self-contained text message containing all answers, conclusions, and deliverables, with the outcome first and no tool calls afterward.",
  "Write for a teammate who has not seen your reasoning or tool results: use clear, complete sentences, familiar terms, and only details that matter.",
  "Match detail to the user's expertise and question: answer simple questions directly in prose, and reserve tables for short lists of facts, with explanations outside the cells.",
  "Match the surrounding code's naming, style, and comment density; add comments only for constraints the code cannot express.",
];

const fileLinkRules = [
  "Your responses are displayed as GitHub-flavored Markdown in the ZPI desktop app.",
  "Return web URLs as Markdown links (e.g., [preview](http://127.0.0.1:8080)).",
  "Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)). Use only existing files or files you created, and use absolute paths for link destinations.",
  "For file locations, append :line:column or #Lstart-Lend to the path (e.g., [app.ts:42](/absolute/path/to/app.ts:42)). For paths containing spaces, wrap the destination in angle brackets (e.g., [My Report.md](</absolute/path/My Report.md>)).",
  "Keep navigable file references and web URLs outside inline code and code blocks. Preserve literal code, directory trees, and syntax examples as code.",
  'The compatible ::zcode-file-citation{path="path/to/file"} directive also opens a local file; paths can be absolute or relative to the current working directory. Prefer Markdown links for ordinary file references.',
];

const proactiveExecutionRules = [
  "When you have enough information to act, act. Treat requests for action as instructions to complete the work, not just to propose a plan or offer to continue. Reuse established facts and respect decisions the user has already made.",
  "Proceed with reversible actions necessary to fulfill the original request without repeatedly asking whether to continue. Resolve routine choices using the request, the code, and sensible defaults; verify facts yourself when possible.",
  "Keep working until the requested outcome is complete or you are blocked on input only the user can provide. Diagnose failures, retry when appropriate, and run relevant checks. Do not end with only a plan, a promise of unfinished work, or a request for permission to continue.",
  "Always honor explicit user instructions to ask for confirmation before specific actions; wait for that confirmation before proceeding with those actions. Ask before destructive, hard-to-reverse, or outward-facing actions unless already authorized, and before material scope changes. Prior authorization remains valid within its stated scope.",
  "When the user only asks for an assessment, explanation, or consultation, report findings without applying changes. Ask clarifying questions only when the missing information cannot be resolved from context, code, or sensible defaults and materially changes what you should do next.",
];

const instructions = (rules: readonly string[]) => ["<system_rules>", ...rules, "</system_rules>"].join("\n");
export const builtinPlugins: readonly SessionPlugin[] = [
  {
    id: "zpi.communication-style",
    version: "1",
    name: "交互方式",
    description: "说明进展，完整交付结论，按问题调整表达。",
    instructions: [instructions(communicationStyleRules)],
  },
  {
    id: "zpi.tool-batching",
    version: "1",
    name: "多工具调用",
    description: "提示助手批量调用工具，并行处理独立调用。",
    instructions: [instructions(["Independent tool calls can run in parallel in one response."])],
  },
  {
    id: "zpi.file-links",
    version: "1",
    name: "文件链接格式",
    description: "使用桌面可点击的文件与网页链接。",
    instructions: [instructions(fileLinkRules)],
  },
  {
    id: "zpi.file-context-reuse",
    version: "1",
    name: "文件内容复用",
    description: "复用上下文中已有的文件内容，减少重复读取。",
    instructions: [
      instructions([
        "Reuse file content already in context, including your successful edits. Do not re-read solely to verify a successful edit/write or because a new turn started.",
      ]),
    ],
  },
  {
    id: "zpi.proactive-execution",
    version: "1",
    name: "主动推进",
    description: "完成已授权工作，并遵守用户指定的确认要求。",
    instructions: [instructions(proactiveExecutionRules)],
  },
  {
    id: "zpi.project-init",
    version: "1",
    name: "项目初始化",
    description: "通过 /init 检查项目并维护根目录 AGENTS.md。",
    commands: [
      {
        name: "init",
        description: "检查项目并创建或编辑 AGENTS.md",
        prompt:
          "Inspect this project ({{cwd}}) and create or edit ONLY its root AGENTS.md. If it exists, read it first and use precise edits to preserve existing rules; do not overwrite it wholesale. Derive concise instructions from the actual project. Never modify the user-level AGENTS.md. Additional requirements: {{arguments}}",
      },
    ],
  },
];
export const desktopPluginIds = {
  questions: "zpi.questions",
  web: "zpi.web-search",
  collaboration: "zpi.collaboration",
  background: "zpi.background-tasks",
  coordinator: "zpi.coordinator",
  memory: "zpi.memory",
  title: "zpi.session-title",
  notifications: "zpi.notifications",
} as const;
export const desktopPluginManifests: readonly PluginSnapshot[] = [
  {
    id: desktopPluginIds.questions,
    runtime: "desktop.questions",
    version: "1",
    name: "向用户提问",
    description: "使用结构化问题澄清用户的选择。",
  },
  {
    id: desktopPluginIds.web,
    runtime: "desktop.web-search",
    version: "1",
    name: "联网搜索",
    description: "通过已配置的联网提供商搜索与读取网页。",
  },
  {
    id: desktopPluginIds.collaboration,
    runtime: "desktop.collaboration",
    version: "1",
    name: "子智能体协作",
    description: "派生子智能体、发送消息并收取结果。",
    options: { promptPreset: "default" },
  },
  {
    id: desktopPluginIds.background,
    runtime: "desktop.background-tasks",
    version: "1",
    name: "后台命令",
    description: "运行持久后台命令，查询输出并停止任务。",
  },
  {
    id: desktopPluginIds.memory,
    runtime: "desktop.memory",
    version: "1",
    name: "记忆策略",
    description: "按选定模式注入记忆、记录使用情况并调度记忆整理。",
    options: { mode: "short" },
  },
  {
    id: desktopPluginIds.title,
    runtime: "desktop.session-title",
    version: "1",
    name: "会话标题",
    description: "为新任务生成简短标题，保留用户手动命名。",
  },
  {
    id: desktopPluginIds.notifications,
    runtime: "desktop.notifications",
    version: "1",
    name: "任务通知",
    description: "任务结束时按本机通知偏好发送提醒。",
  },
];
export const builtinPluginCatalog: readonly PluginSnapshot[] = [...builtinPlugins, ...desktopPluginManifests];
export const builtinPluginMetadata = builtinPluginCatalog.map(({ id, version, name, description }) => ({
  id,
  version,
  name,
  description,
}));
export interface BuiltinHookDeclaration {
  key: string;
  event: HookEvent;
  description: string;
  matcher?: string;
  onError?: "block";
}
/** One declaration feeds runtime binding and the read-only settings projection. */
export function builtinPluginHooks(plugin: PluginSnapshot): BuiltinHookDeclaration[] {
  switch (plugin.id) {
    case desktopPluginIds.memory:
      return plugin.options?.mode === "long"
        ? [
            {
              key: "begin",
              event: "UserPromptSubmit",
              description: "重置本轮记忆来源记录，并按需调度后台整理",
              onError: "block",
            },
            {
              key: "read",
              event: "PostToolUse",
              matcher: "^read$",
              description: "记录长期记忆来源的读取",
            },
          ]
        : [];
    case desktopPluginIds.title:
      return [
        { key: "fallback", event: "InputAccepted", description: "设置任务的临时标题" },
        { key: "start", event: "RunStart", description: "生成会话标题" },
      ];
    case desktopPluginIds.notifications:
      return [{ key: "send", event: "Notification", description: "按通知偏好发送任务提醒" }];
    default:
      return [];
  }
}
export const defaultPluginSettings = {
  version: 2 as const,
  enabled: Object.fromEntries(builtinPluginCatalog.map((plugin) => [plugin.id, true])),
  options: {} as Record<string, JsonObject>,
};
export function validateBuiltinPluginOptions(id: string, options: JsonObject): void {
  if (id === desktopPluginIds.memory) {
    if (
      Object.keys(options).some((key) => key !== "mode") ||
      (options.mode !== undefined && !["off", "short", "long"].includes(options.mode as string))
    )
      throw new Error("invalid_input: 无效记忆模式");
  } else if (id === desktopPluginIds.collaboration) {
    if (
      Object.keys(options).some((key) => key !== "promptPreset") ||
      (options.promptPreset !== undefined &&
        (typeof options.promptPreset !== "string" || !["default", "codex"].includes(options.promptPreset)))
    )
      throw new Error("invalid_input: 无效协作提示预设");
  } else if (builtinPluginCatalog.some((plugin) => plugin.id === id) && Object.keys(options).length) {
    throw new Error("invalid_input: 此插件没有可配置选项");
  }
}
export function enabledBuiltinPlugins(settings: typeof defaultPluginSettings): PluginSnapshot[] {
  return builtinPluginCatalog
    .filter((plugin) => settings.enabled[plugin.id] ?? defaultPluginSettings.enabled[plugin.id])
    .map((plugin) => ({ ...plugin, options: { ...plugin.options, ...settings.options[plugin.id] } }));
}
