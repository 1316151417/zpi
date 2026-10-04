import { code, type HighlightOptions, type HighlightResult } from "@streamdown/code";
import { WrapText } from "lucide-react";
import { useEffect, useState } from "react";
import { useAppearance } from "../appearance.ts";
import { MarkdownCopy, useMarkdown } from "./MarkdownActions.tsx";
import { FileIcon } from "./Reference.tsx";

const displayFiles: Record<string, string> = {
  bash: "script.sh",
  css: "style.css",
  go: "main.go",
  html: "index.html",
  javascript: "index.js",
  js: "index.js",
  jsx: "component.jsx",
  json: "data.json",
  markdown: "README.md",
  md: "README.md",
  mermaid: "diagram.mmd",
  mmd: "diagram.mmd",
  python: "main.py",
  py: "main.py",
  rs: "main.rs",
  rust: "main.rs",
  sh: "script.sh",
  shell: "script.sh",
  toml: "config.toml",
  ts: "index.ts",
  tsx: "component.tsx",
  typescript: "index.ts",
  yaml: "config.yaml",
  yml: "config.yml",
  zsh: "script.zsh",
};

export function MarkdownCode({
  source,
  language,
  incomplete,
}: {
  source: string;
  language: string;
  incomplete: boolean;
}) {
  const { streaming } = useMarkdown();
  const { theme } = useAppearance();
  const [wrap, setWrap] = useState(false);
  const [highlight, setHighlight] = useState<{ source: string; language: string; result: HighlightResult }>();
  useEffect(() => {
    // Wait for the message to finish; asynchronous highlighting must not compete with streaming updates.
    if (streaming || incomplete || !code.supportsLanguage(language as HighlightOptions["language"])) return;
    let active = true;
    const receive = (result: HighlightResult) => {
      if (active) setHighlight({ source, language, result });
    };
    const result = code.highlight(
      {
        code: source,
        language: language as HighlightOptions["language"],
        themes: ["github-light", "github-dark"],
      },
      receive,
    );
    if (result) receive(result);
    return () => {
      active = false;
    };
  }, [source, language, streaming, incomplete]);
  const tokens =
    !streaming && !incomplete && highlight?.source === source && highlight.language === language
      ? highlight.result.tokens
      : undefined;
  return (
    <div
      data-streamdown="code-block"
      data-incomplete={incomplete}
      className={`markdown-code ${wrap ? "wrap" : ""}`}
    >
      <div data-streamdown="code-block-header" className="markdown-code-header">
        <span className="markdown-code-language">
          <FileIcon path={displayFiles[language] ?? `code.${language}`} />
          <span>{language}</span>
        </span>
        <div className="markdown-toolbar">
          <button
            type="button"
            className="markdown-action"
            title="自动换行"
            aria-label="自动换行"
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
          >
            <WrapText size={14} />
          </button>
          <MarkdownCopy text={source} label="复制代码" disabled={incomplete || streaming} />
        </div>
      </div>
      <div data-streamdown="code-block-body" className="markdown-code-body">
        <pre>
          <code>
            {tokens
              ? tokens.map((line, index) => (
                  <span key={index}>
                    {line.map((token, position) => (
                      <span
                        key={position}
                        style={{
                          color:
                            theme === "dark"
                              ? (token.htmlStyle?.["--shiki-dark"] ?? token.color)
                              : (token.htmlStyle?.color ?? token.color),
                        }}
                      >
                        {token.content}
                      </span>
                    ))}
                    {index < tokens.length - 1 ? "\n" : ""}
                  </span>
                ))
              : source}
          </code>
        </pre>
      </div>
    </div>
  );
}
