// Adapted from ZCode's DOCX and legacy DOC preview fitting (Apache-2.0).
import { type CSSProperties, useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  calculateDocxPreviewFit,
  type DocxPreviewFit,
  isSameDocxPreviewFit,
} from "./office-preview-model.ts";

export function useDocxPreviewFit(sourcePath: string, ready = true) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<DocxPreviewFit | null>(null);
  const resetFit = useCallback(() => setFit(null), []);

  useLayoutEffect(() => {
    if (!ready) return;
    const updateFit = () => {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!viewport || !content) return;
      const next = calculateDocxPreviewFit({
        availableWidth: viewport.clientWidth,
        naturalHeight: content.offsetHeight,
        naturalWidth: content.offsetWidth,
      });
      if (next) setFit((current) => (isSameDocxPreviewFit(current, next) ? current : next));
    };
    updateFit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateFit);
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [ready, sourcePath]);

  const frameStyle: CSSProperties | undefined = fit ? { width: fit.width, height: fit.height } : undefined;
  const contentStyle: CSSProperties | undefined = fit
    ? {
        position: "absolute",
        left: 0,
        top: 0,
        transform: `scale(${fit.scale})`,
        transformOrigin: "top left",
      }
    : undefined;
  return { viewportRef, contentRef, fit, resetFit, frameStyle, contentStyle };
}
