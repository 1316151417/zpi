import type { FileResourceLoader, ResourceLoader } from "zpi-coding-agent";
import type { PluginCapabilities } from "../shared/bridge.ts";

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

type PromptCapabilities = Pick<
  PluginCapabilities,
  "toolBatching" | "fileLinks" | "fileContextReuse" | "proactiveExecution"
>;

export function pluginSystemRules(capabilities: PromptCapabilities) {
  const rules = [
    ...(capabilities.toolBatching ? ["Independent tool calls can run in parallel in one response."] : []),
    ...(capabilities.fileLinks ? fileLinkRules : []),
    ...(capabilities.fileContextReuse
      ? [
          "Reuse file content already in context, including your successful edits. Do not re-read solely to verify a successful edit/write or because a new turn started.",
        ]
      : []),
    ...(capabilities.proactiveExecution ? proactiveExecutionRules : []),
  ];
  return rules.length ? ["<system_rules>", ...rules, "</system_rules>"].join("\n") : "";
}

export function withDesktopSystemRules(
  loader: FileResourceLoader,
  capabilities: PromptCapabilities,
): ResourceLoader {
  const rules = pluginSystemRules(capabilities);
  return {
    getSystemPrompt: () => loader.getSystemPrompt(),
    getAppendSystemPrompt: () => [...loader.getAppendSystemPrompt(), ...(rules ? [rules] : [])],
    reload: () => loader.reload(),
    listSkills: () => loader.listSkills(),
    loadSkill: (name) => loader.loadSkill(name),
    getDiagnostics: () => loader.getDiagnostics(),
  };
}
