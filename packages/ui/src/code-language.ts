import type { BundledLanguage } from "shiki";

// ZCode codeViewer.ts extension mapping; unknown patch paths use diff syntax.
const languages: Record<string, BundledLanguage> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  diff: "diff",
  go: "go",
  h: "c",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  mermaid: "mermaid",
  mmd: "mermaid",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  text: "log",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  txt: "log",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

export function toolCodeLanguage(path: string, content = ""): BundledLanguage {
  const leaf = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1);
  const extension = leaf?.includes(".") ? leaf.split(".").at(-1)?.toLowerCase() : undefined;
  if (extension && Object.hasOwn(languages, extension)) return languages[extension];
  if (content.startsWith("#!/")) {
    if (content.includes("python")) return "python";
    if (content.includes("bash") || content.includes("sh")) return "bash";
  }
  if (/^(diff --git|--- |\+\+\+ |@@ )/m.test(content)) return "diff";
  return "log";
}

/** Preserve the standalone patch preview's extension-only diff fallback. */
export function toolPatchLanguage(path: string): BundledLanguage {
  return languages[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "diff";
}
