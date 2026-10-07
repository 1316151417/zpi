// ZCode ExecuteOutput/ScrollFadeViewport semantics (872ad96, Apache-2.0).
import { useLayoutEffect, useRef, useState } from "react";

export function ToolOutput({
  text,
  running,
  selectionKey,
}: {
  text: string;
  running: boolean;
  selectionKey: string;
}) {
  const scroll = useRef<HTMLElement>(null);
  const content = useRef<HTMLPreElement>(null);
  const previousTop = useRef(0);
  const hasStreamed = useRef(running);
  const [frozen, setFrozen] = useState<string | null>(null);
  const [mask, setMask] = useState("none");
  const display = frozen ?? text;
  const following = frozen === null;
  const updateMask = () => {
    const el = scroll.current;
    if (!el) return;
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop < el.scrollHeight - el.clientHeight - 1;
    setMask(top && bottom ? "both" : top ? "top" : bottom ? "bottom" : "none");
  };
  useLayoutEffect(() => {
    if (running) hasStreamed.current = true;
    if (hasStreamed.current && following && scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight;
      previousTop.current = scroll.current.scrollTop;
    }
    updateMask();
    const observer = new ResizeObserver(updateMask);
    if (scroll.current) observer.observe(scroll.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [display, following, running]);
  return (
    <section
      ref={scroll}
      className="tool-output-scroll scroll-fade-viewport"
      data-testid="bash-output-scroll"
      data-following={following}
      data-scroll-mask={mask}
      aria-label="终端输出"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The output viewport supports keyboard scrolling.
      tabIndex={0}
      onScroll={(event) => {
        const el = event.currentTarget;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
        // 向上阅读时冻结已显示输出，避免新 token 挤走当前位置；回到底部再恢复。
        if (hasStreamed.current && following && el.scrollTop < previousTop.current && !atBottom)
          setFrozen(display);
        else if (!following && atBottom) setFrozen(null);
        previousTop.current = el.scrollTop;
        updateMask();
      }}
    >
      <pre
        ref={content}
        className="tool-output"
        data-conversation-selectable="tool"
        data-selection-key={selectionKey}
      >
        {display}
      </pre>
    </section>
  );
}
