// Adapted from ZCode v4/ConversationUserInputBody.tsx (Apache-2.0).
import { ChevronDown, ChevronUp } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

const collapsedHeight = 120;

export function UserMessageBody({ children, text }: { children: ReactNode; text: string }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(collapsedHeight);
  const expandable = height > collapsedHeight + 1;
  const [expanded, setExpanded] = useState(false);
  const [animate, setAnimate] = useState(true);
  useEffect(() => setExpanded(false), [text]);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setHeight(content.scrollHeight);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [text]);
  // Find navigation can reveal a match below the collapsed portion.
  useEffect(() => {
    const content = contentRef.current;
    const reveal = () => {
      setAnimate(false);
      setExpanded(true);
    };
    content?.addEventListener("zpi-reveal-user-message", reveal);
    return () => content?.removeEventListener("zpi-reveal-user-message", reveal);
  }, []);
  const label = expanded ? "收起" : "展开";
  return (
    <div className="user-message-body" data-expanded={expanded} data-expandable={expandable}>
      <div
        className="user-message-content"
        style={{
          maxHeight: `${expanded ? Math.max(height, collapsedHeight) : collapsedHeight}px`,
          transition: animate ? undefined : "none",
        }}
      >
        <div ref={contentRef} className="user-message-content-inner">
          {children}
        </div>
      </div>
      {expandable && (
        <div className="user-message-toggle-row">
          <button
            type="button"
            className="user-message-toggle"
            aria-label={label}
            aria-expanded={expanded}
            title={label}
            onClick={() => {
              setAnimate(true);
              setExpanded((value) => !value);
            }}
          >
            {expanded ? (
              <ChevronUp size={16} aria-hidden="true" />
            ) : (
              <ChevronDown size={16} aria-hidden="true" />
            )}
          </button>
        </div>
      )}
    </div>
  );
}
