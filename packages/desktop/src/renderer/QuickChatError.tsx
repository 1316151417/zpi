import { CircleAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function QuickChatError({
  message,
  occurrence,
  reservedHeight,
  onHeightChange,
  children,
}: {
  message: string;
  occurrence: number;
  reservedHeight: number;
  onHeightChange: (height: number) => void;
  children: ReactNode;
}) {
  const descriptionId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const [automatic, setAutomatic] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const open = automatic || hovered || focused;

  useEffect(() => {
    setAutomatic(true);
    const timer = setTimeout(() => setAutomatic(false), 3000);
    return () => clearTimeout(timer);
  }, [message, occurrence]);

  useEffect(
    () => () => {
      clearTimeout(leaveTimer.current);
      onHeightChange(0);
    },
    [onHeightChange],
  );

  useLayoutEffect(() => {
    if (!open) {
      onHeightChange(0);
      return;
    }
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const content = tooltip.current;
      if (!anchor || !content) return;
      const height = content.offsetHeight;
      const width = content.offsetWidth;
      // Anchor above the trigger, but keep the bubble inside the window even when
      // the trigger sits at an edge (the expanded error row starts at the left).
      content.style.bottom = `${Math.min(
        window.innerHeight - anchor.top + 8,
        Math.max(12, window.innerHeight - height - 12),
      )}px`;
      content.style.right = `${Math.min(
        Math.max(12, window.innerWidth - anchor.right),
        Math.max(12, window.innerWidth - width - 12),
      )}px`;
      onHeightChange(Math.min(172, Math.ceil(height) + 12));
    };
    position();
    const observer = new ResizeObserver(position);
    if (tooltip.current) observer.observe(tooltip.current);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [open, message, reservedHeight, onHeightChange]);

  const enter = () => {
    clearTimeout(leaveTimer.current);
    setHovered(true);
  };
  const leave = () => {
    leaveTimer.current = setTimeout(() => setHovered(false), 100);
  };

  return (
    <div className="quick-chat-error" role="alert">
      <span id={descriptionId} className="quick-chat-error-description">
        {message}
      </span>
      <button
        ref={trigger}
        type="button"
        className="quick-chat-error-trigger"
        aria-label="查看错误原因"
        aria-describedby={descriptionId}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={() => setFocused(true)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          event.preventDefault();
          event.stopPropagation();
          setAutomatic(false);
          setHovered(false);
          setFocused(false);
        }}
      >
        <CircleAlert size={15} aria-hidden="true" />
      </button>
      {children}
      {open &&
        createPortal(
          <div
            ref={tooltip}
            className="quick-chat-error-tooltip"
            role="tooltip"
            onPointerEnter={enter}
            onPointerLeave={leave}
          >
            {message}
          </div>,
          document.body,
        )}
    </div>
  );
}
