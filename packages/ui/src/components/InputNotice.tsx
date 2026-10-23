import { CircleAlert } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function InputNotice({
  message,
  reservedHeight,
  onHeightChange,
  children,
  onDismiss,
  className = "",
}: {
  message: string;
  reservedHeight?: number;
  onHeightChange?: (height: number) => void;
  children?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const descriptionId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const [automatic, setAutomatic] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const open = automatic || hovered || focused;
  const [expired, setExpired] = useState(false);
  const dismiss = useEffectEvent(() => onDismiss?.());

  useEffect(() => {
    const timer = setTimeout(() => setAutomatic(false), 3000);
    const expiry = setTimeout(() => setExpired(true), 8000);
    return () => {
      clearTimeout(timer);
      clearTimeout(expiry);
    };
  }, []);

  useEffect(() => {
    if (expired && !hovered && !focused) dismiss();
  }, [expired, hovered, focused]);

  useLayoutEffect(
    () => () => {
      clearTimeout(leaveTimer.current);
      onHeightChange?.(0);
    },
    [onHeightChange],
  );

  useLayoutEffect(() => {
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const content = tooltip.current;
      if (!anchor || !content) return;
      const height = content.offsetHeight;
      const width = content.offsetWidth;
      // Keep the bubble above its trigger and inside the viewport.
      content.style.bottom = `${Math.min(
        window.innerHeight - anchor.top + 8,
        Math.max(12, window.innerHeight - height - 12),
      )}px`;
      content.style.right = `${Math.min(
        Math.max(12, window.innerWidth - anchor.right),
        Math.max(12, window.innerWidth - width - 12),
      )}px`;
      // Reserve space for the entire notice lifetime. Hover must never resize
      // the native window underneath the pointer.
      onHeightChange?.(Math.min(172, Math.ceil(height) + 12));
    };
    position();
    const observer = new ResizeObserver(position);
    if (tooltip.current) observer.observe(tooltip.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, message, reservedHeight, onHeightChange]);

  const enter = () => {
    clearTimeout(leaveTimer.current);
    setHovered(true);
  };
  const leave = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHovered(false), 100);
  };

  return (
    <div className={`input-notice ${className}`} role="alert" data-notice-scope="input">
      <span id={descriptionId} className="input-notice-description">
        {message}
      </span>
      <button
        ref={trigger}
        type="button"
        className="input-notice-trigger"
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
      {createPortal(
        <div
          ref={tooltip}
          className="input-notice-tooltip"
          role={open ? "tooltip" : undefined}
          aria-hidden={!open}
          style={{ visibility: open ? "visible" : "hidden" }}
          onPointerEnter={enter}
          onPointerLeave={leave}
          onFocus={() => setFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
          }}
        >
          {message}
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}
