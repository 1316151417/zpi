// ZCode EditInlineDiffContent/lightweight-diff-preview presentation (Apache-2.0).
import { useEffect, useMemo, useRef, useState } from "react";
import type { BundledLanguage, ThemedToken } from "shiki";
import { useAppearance } from "../appearance.ts";
import { toolPatchLanguage } from "../code-language.ts";
import { patchPreviewLines } from "./tool-presentation.ts";

import { useSelectionStableValue } from "./use-selection-stable-value.ts";

export { toolCodeLanguage } from "../code-language.ts";

export function useToolTokens(code: string, language: BundledLanguage, streaming = false) {
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
    const highlight = () => {
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
    };
    // Keep content immediate; coalesce costly full-document tokenization while streaming.
    const timer = streaming ? setTimeout(highlight, 150) : undefined;
    if (!streaming) highlight();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [code, language, theme, streaming]);
  return highlight?.code === code && highlight.language === language && highlight.theme === theme
    ? highlight.tokens
    : undefined;
}

export function ToolCode({
  text,
  language = "json",
  streaming = false,
}: {
  text: string;
  language?: BundledLanguage;
  streaming?: boolean;
}) {
  const tokens = useToolTokens(text, language, streaming);
  const root = useRef<HTMLDivElement>(null);
  const incoming = useMemo(() => ({ text, language, tokens }), [text, language, tokens]);
  const display = useSelectionStableValue(incoming, language, root);
  return (
    <div ref={root} className="tool-input-code" data-language={display.language}>
      <pre>
        <code>
          {display.tokens
            ? display.tokens.map((line, i, lines) => (
                <span key={i}>
                  {line.map((token, j) => (
                    <span key={j} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))}
                  {i < lines.length - 1 ? "\n" : ""}
                </span>
              ))
            : display.text}
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
