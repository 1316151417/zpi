import type { FileResourceLoader, ResourceLoader } from "ZPI-coding-agent";

export const desktopSystemRules = [
  "<system_rules>",
  "Independent tool calls can run in parallel in one response.",
  "Your responses are displayed as GitHub-flavored Markdown in the ZPI desktop app.",
  "Return web URLs as Markdown links (e.g., [preview](http://127.0.0.1:8080)).",
  "Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)). Use only existing files or files you created, and use absolute paths for link destinations.",
  "For file locations, append :line:column or #Lstart-Lend to the path (e.g., [app.ts:42](/absolute/path/to/app.ts:42)). For paths containing spaces, wrap the destination in angle brackets (e.g., [My Report.md](</absolute/path/My Report.md>)).",
  "Keep navigable file references and web URLs outside inline code and code blocks. Preserve literal code, directory trees, and syntax examples as code.",
  'The compatible ::zcode-file-citation{path="path/to/file"} directive also opens a local file; paths can be absolute or relative to the current working directory. Prefer Markdown links for ordinary file references.',
  "</system_rules>",
].join("\n");

// Future custom rules belong in a separate appended section, leaving built-in rules read-only.
export function withDesktopSystemRules(loader: FileResourceLoader): ResourceLoader {
  return {
    getSystemPrompt: () => loader.getSystemPrompt(),
    getAppendSystemPrompt: () => [...loader.getAppendSystemPrompt(), desktopSystemRules],
    reload: () => loader.reload(),
    listSkills: () => loader.listSkills(),
    loadSkill: (name) => loader.loadSkill(name),
    getDiagnostics: () => loader.getDiagnostics(),
  };
}
