// Rendering queue, palette normalization and base theme adapted from ZCode 872ad960.
// Apache-2.0; desktop labels and theme tokens adapted for ZPI. See THIRD_PARTY_NOTICES.md.
import { createMermaidPlugin, type MermaidConfig } from "@streamdown/mermaid";
import { Maximize2, X } from "lucide-react";
import { memo, useEffect, useId, useMemo, useState } from "react";
import { useAppearance } from "../appearance.ts";
import { getCurrentMermaidDocumentVisibility, resolveMermaidAutoRenderDecision } from "./mermaid-budget.ts";

const mermaidPlugin = createMermaidPlugin();
let mermaidRenderQueue = Promise.resolve();
const MERMAID_COLOR_CANVAS_SENTINEL = "#010203";

// Mermaid 底层的 khroma 解析器不支持 Tailwind v4 常见的 oklab/color-mix 结果。
// 先让浏览器解析主题 token，再通过 canvas 采样成传统 rgb/rgba，避免把现代 CSS 颜色直接传给 Mermaid。
// Web 远程控制的启动测试只提供了最小 document mock，SSR/预渲染环境也可能没有 DOM 工厂；
// 颜色归一化是增强能力，不能让 MessageResponse 的静态导入在这些环境中直接崩溃。
const canCreateDomElements = typeof document !== "undefined" && typeof document.createElement === "function";
const mermaidColorResolverEl: HTMLSpanElement | null = canCreateDomElements
  ? document.createElement("span")
  : null;
const mermaidColorNormalizeCtx: CanvasRenderingContext2D | null = (() => {
  if (!canCreateDomElements) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx) {
    ctx.globalCompositeOperation = "copy";
  }
  return ctx;
})();

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function hashMermaidCode(code: string): string {
  let hash = 2166136261;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function normalizeCssColorForMermaid(raw: string, fallback: string): string {
  if (!raw || !mermaidColorResolverEl || !mermaidColorNormalizeCtx || !document.body) {
    return raw || fallback;
  }

  try {
    document.body.appendChild(mermaidColorResolverEl);
    mermaidColorResolverEl.style.color = "";
    mermaidColorResolverEl.style.color = raw;
    const resolved = getComputedStyle(mermaidColorResolverEl).color;
    if (!resolved) {
      return fallback;
    }

    mermaidColorNormalizeCtx.clearRect(0, 0, 1, 1);
    mermaidColorNormalizeCtx.fillStyle = MERMAID_COLOR_CANVAS_SENTINEL;
    const sentinelFillStyle = mermaidColorNormalizeCtx.fillStyle;
    mermaidColorNormalizeCtx.fillStyle = resolved;
    // 如果 canvas 也不支持该颜色格式，fillStyle 会停在哨兵色，直接回退到 Mermaid 可解析的安全色。
    if (mermaidColorNormalizeCtx.fillStyle === sentinelFillStyle) {
      return fallback;
    }

    mermaidColorNormalizeCtx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = mermaidColorNormalizeCtx.getImageData(0, 0, 1, 1).data;
    const roundedAlpha = +(a / 255).toFixed(3);
    return roundedAlpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${roundedAlpha})`;
  } catch {
    return fallback;
  } finally {
    mermaidColorResolverEl.remove();
  }
}

function resolveCssColor(variableName: string, fallback: string): string {
  if (typeof document === "undefined" || !document.body) {
    return fallback;
  }

  const probe = document.createElement("span");
  probe.style.color = `var(${variableName})`;
  probe.style.pointerEvents = "none";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();

  return normalizeCssColorForMermaid(color, fallback);
}

function createMermaidConfig(resolvedTheme: "light" | "dark", fontSize: string): MermaidConfig {
  const background = resolveCssColor("--color-surface", resolvedTheme === "dark" ? "#18181b" : "#ffffff");
  const surface = resolveCssColor("--color-surface-muted", resolvedTheme === "dark" ? "#27272a" : "#f4f4f5");
  const accent = resolveCssColor("--color-active", resolvedTheme === "dark" ? "#1f2937" : "#f0f9ff");
  const text = resolveCssColor("--color-text", resolvedTheme === "dark" ? "#f4f4f5" : "#27272a");
  const subtleText = resolveCssColor("--color-text-muted", resolvedTheme === "dark" ? "#a1a1aa" : "#52525b");
  const border = resolveCssColor("--color-border", resolvedTheme === "dark" ? "#3f3f46" : "#d4d4d8");

  return {
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: {
      fontSize,
      actorBkg: background,
      actorBorder: border,
      actorTextColor: text,
      background,
      lineColor: subtleText,
      mainBkg: background,
      nodeBorder: border,
      noteBkgColor: accent,
      noteTextColor: text,
      primaryBorderColor: border,
      primaryColor: surface,
      primaryTextColor: text,
      secondaryBorderColor: border,
      secondaryColor: accent,
      secondaryTextColor: text,
      signalColor: subtleText,
      signalTextColor: text,
      tertiaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: text,
      textColor: text,
    },
  };
}

function sizeInlineDiagram(element: HTMLDivElement | null) {
  const svg = element?.querySelector("svg");
  const width = svg?.viewBox.baseVal.width ?? 0;
  // Preserve natural diagram size in the scroll container. Percentage-width
  // SVGs otherwise shrink wide graphs under the desktop's flex layout.
  if (svg && Number.isFinite(width) && width > 0) svg.style.width = `${width}px`;
}

export const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  const renderIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const { theme, fontSize } = useAppearance();
  const dark = theme === "dark";
  const [visibility, setVisibility] = useState(getCurrentMermaidDocumentVisibility);
  const [renderState, setRenderState] = useState<{ status: "loading" | "ready" | "plaintext"; svg?: string }>(
    { status: "loading" },
  );
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    const visible = () => setVisibility(getCurrentMermaidDocumentVisibility());
    document.addEventListener("visibilitychange", visible);
    return () => {
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  const config = useMemo(() => createMermaidConfig(theme, fontSize), [theme, fontSize]);
  const trimmedCode = code.trim();
  const decision = useMemo(
    () => resolveMermaidAutoRenderDecision(trimmedCode, { documentVisibilityState: visibility }),
    [trimmedCode, visibility],
  );
  useEffect(() => {
    let cancelled = false;
    setPreview(false);
    if (!trimmedCode || !decision.shouldRender) {
      setRenderState({ status: "plaintext" });
      return;
    }
    setRenderState({ status: "loading" });
    const renderId = `ZPI-mermaid-${renderIdPrefix}-${hashMermaidCode(`${dark}:${trimmedCode}`)}`;
    void enqueueMermaidRender(async () => {
      if (cancelled) return undefined;
      return mermaidPlugin.getMermaid(config).render(renderId, trimmedCode);
    })
      .then((result) => {
        if (!cancelled && result) setRenderState({ status: "ready", svg: result.svg });
      })
      .catch(() => {
        if (!cancelled) setRenderState({ status: "plaintext" });
      });
    return () => {
      cancelled = true;
    };
  }, [trimmedCode, config, dark, decision, renderIdPrefix]);
  return (
    <div
      data-streamdown="mermaid-block"
      data-mermaid-block=""
      data-render-state={renderState.status}
      className="ZPI-mermaid"
    >
      <div className="mermaid-toolbar">
        <span>mermaid</span>
        <button
          type="button"
          aria-label="放大图表"
          title="放大图表"
          disabled={renderState.status !== "ready"}
          onClick={() => setPreview(true)}
        >
          <Maximize2 size={13} />
        </button>
      </div>
      <div className="mermaid-scroll">
        {renderState.status === "loading" && (
          <div className="mermaid-pending" role="status">
            图表生成中…
          </div>
        )}
        {renderState.status === "plaintext" && <pre className="mermaid-source">{code}</pre>}
        {renderState.status === "ready" && (
          <div
            role="img"
            aria-label="Mermaid 图表"
            className="mermaid-diagram"
            ref={sizeInlineDiagram}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid strict mode sanitizes the generated SVG with DOMPurify.
            dangerouslySetInnerHTML={{ __html: renderState.svg ?? "" }}
            onDoubleClick={() => setPreview(true)}
          />
        )}
      </div>
      {preview && renderState.svg && (
        <dialog
          className="mermaid-preview"
          aria-label="图表预览"
          ref={(el) => {
            if (el && !el.open) el.showModal();
          }}
          onCancel={() => setPreview(false)}
        >
          <div className="mermaid-toolbar">
            <span>图表预览</span>
            <button type="button" aria-label="关闭图表预览" onClick={() => setPreview(false)}>
              <X size={18} />
            </button>
          </div>
          <div className="mermaid-scroll">
            <div
              role="img"
              aria-label="Mermaid 图表预览"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: This is the same strict-mode sanitized SVG as the inline diagram.
              dangerouslySetInnerHTML={{ __html: renderState.svg }}
            />
          </div>
        </dialog>
      )}
    </div>
  );
});
