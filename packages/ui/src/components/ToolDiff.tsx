// ZCode EditInlineDiffContent/lightweight-diff-preview presentation (Apache-2.0).
import { useEffect, useMemo, useState } from "react";
import type { BundledLanguage, ThemedToken } from "shiki";
import { useAppearance } from "../appearance.ts";
import { toolPatchLanguage } from "../code-language.ts";
import { patchPreviewLines } from "./tool-presentation.ts";

export { toolCodeLanguage } from "../code-language.ts";

export function useToolTokens(code: string, language: BundledLanguage) {
  const { theme } = useAppearance();
  const [highlight, setHighlight] = useState<{
    code: string;
    language: BundledLanguage;
    theme: string;
    tokens: ThemedToken[][];
  }>();
  useEffect(() => {
    let active = true;
    setHighlight(undefined);
    // Match ZCode's lightweight preview cutoff and its plain-text/log fast path.
    if (!code || code.length > 120_000 || language === "log") return;
    void import("shiki")
      .then(({ codeToTokens }) => {
        if (!active) return;
        return codeToTokens(code, {
          lang: language,
          theme: theme === "dark" ? "github-dark" : "github-light",
        });
      })
      .then((result) => {
        if (active && result) setHighlight({ code, language, theme, tokens: result.tokens });
      })
      .catch(() => {
        /* 纯文本首帧始终保留。 */
      });
    return () => {
      active = false;
    };
  }, [code, language, theme]);
  return highlight?.code === code && highlight.language === language && highlight.theme === theme
    ? highlight.tokens
    : undefined;
}

export function ToolCode({ text, language = "json" }: { text: string; language?: BundledLanguage }) {
  const tokens = useToolTokens(text, language);
  return (
    <div className="tool-input-code" data-language={language}>
      <pre>
        <code>
          {tokens
            ? tokens.map((line, i) => (
                <span key={i}>
                  {line.map((token, j) => (
                    <span key={j} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))}
                  {i < tokens.length - 1 ? "\n" : ""}
                </span>
              ))
            : text}
        </code>
      </pre>
    </div>
  );
}

export function ToolDiff({
  patch,
  path,
  selectionKey,
}: {
  patch: string;
  path: string;
  selectionKey: string;
}) {
  const lines = useMemo(() => patchPreviewLines(patch), [patch]);
  const code = useMemo(
    () => lines.map((line) => (/^[ +-]/.test(line) ? line.slice(1) : line)).join("\n"),
    [lines],
  );
  const language = toolPatchLanguage(path);
  const tokens = useToolTokens(code, language);
  return (
    <div className="tool-inline-diff" data-inline-diff-preview>
      <div
        className="tool-diff-lines"
        data-conversation-selectable="tool"
        data-selection-key={selectionKey}
        data-selection-path={path}
      >
        {lines.map((line, index) => {
          const omitted = /^\\ __ZCODE_DIFF_TRUNCATED__:(\d+)$/.exec(line)?.[1];
          if (omitted)
            return (
              <div key={index} className="tool-diff-omitted">
                Diff 预览已截断：为保持界面流畅，省略了 {omitted} 行。
              </div>
            );
          const kind = line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context";
          const text = /^[ +-]/.test(line) ? line.slice(1) : line;
          return (
            <div key={index} className={`tool-diff-line ${kind}`}>
              <span className="tool-diff-number" aria-hidden="true">
                {index + 1}
              </span>
              <code>
                {tokens?.[index]?.map((token, i) => (
                  <span key={i} style={{ color: token.color }}>
                    {token.content}
                  </span>
                )) ??
                  (text || " ")}
              </code>
            </div>
          );
        })}
      </div>
    </div>
  );
}
