// Adapted from ZCode ModelEditorAdvanced (Apache-2.0).
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

export function ModelConfigAdvanced({
  children,
  invalidMapping,
  validationAttempt,
}: {
  children: ReactNode;
  invalidMapping: boolean;
  validationAttempt: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (invalidMapping) setExpanded(true);
  }, [invalidMapping, validationAttempt]);
  useEffect(() => {
    if (!invalidMapping || !expanded) return;
    let cancelled = false;
    const animations = ref.current?.getAnimations({ subtree: true }) ?? [];
    void Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {
      if (!cancelled)
        ref.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="推理参数映射"]')?.focus();
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, invalidMapping, validationAttempt]);
  return (
    <div ref={ref} className="model-config-advanced">
      <button
        type="button"
        className="model-advanced-trigger"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight size={16} aria-hidden="true" />
        高级配置
      </button>
      <div
        id={contentId}
        className="model-advanced-content"
        inert={!expanded}
        aria-hidden={!expanded}
        data-expanded={expanded}
      >
        <div className="model-advanced-clip">
          <div className="model-advanced-fields">{children}</div>
        </div>
      </div>
    </div>
  );
}
