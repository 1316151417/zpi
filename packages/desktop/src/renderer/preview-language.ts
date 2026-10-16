// Adapted from ZCode codeViewer.ts (Apache-2.0).
import type { BundledLanguage } from "@pierre/diffs";

const extensionLanguages: Record<string, BundledLanguage> = {
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

/** Preserve the reference's log highlighting for plain text and unknown extensions. */
export function inferPreviewLanguage(path?: string, contentHint?: string): BundledLanguage {
  const leaf = path?.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1);
  const extension = leaf?.includes(".") ? leaf.split(".").at(-1)?.toLowerCase() : undefined;
  if (extension && Object.hasOwn(extensionLanguages, extension)) return extensionLanguages[extension];
  if (contentHint?.startsWith("#!/")) {
    if (contentHint.includes("python")) return "python";
    if (contentHint.includes("bash") || contentHint.includes("sh")) return "bash";
  }
  if (contentHint && /^(diff --git|--- |\+\+\+ |@@ )/m.test(contentHint)) return "diff";
  return "log";
}
