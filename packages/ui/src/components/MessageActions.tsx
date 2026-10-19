// Layout, Lucide assets and copy feedback follow ZCode ConversationRowView (Apache-2.0).
import * as Tooltip from "@radix-ui/react-tooltip";
import { Check, Copy } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
export function MessageAction({
  label,
  children,
  shortcut,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; shortcut?: string }) {
  return (
    <ActionHint label={label} shortcut={shortcut}>
      <button type="button" className="message-action" aria-label={label} {...props}>
        {children}
      </button>
    </ActionHint>
  );
}
export function ActionHint({
  label,
  children,
  description,
  shortcut,
  side,
  sideOffset = 2,
  hideWhenDetached,
  appearance = "message",
  open,
  openOnFocus = appearance !== "control",
  className,
}: {
  label: string;
  children: ReactNode;
  description?: string;
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
  hideWhenDetached?: boolean;
  appearance?: "message" | "control";
  open?: boolean;
  /** Restored focus should not reveal a hint unless the pointer is already over its trigger. */
  openOnFocus?: boolean;
  className?: string;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const pointerInside = useRef(false);
  useEffect(() => {
    if (open === false) setUncontrolledOpen(false);
  }, [open]);
  return (
    <Tooltip.Provider delayDuration={0}>
      <Tooltip.Root
        open={open ?? uncontrolledOpen}
        onOpenChange={(next) => {
          if (next && !openOnFocus && !pointerInside.current) return;
          setUncontrolledOpen(next);
        }}
      >
        <Tooltip.Trigger
          asChild
          onPointerEnter={() => {
            pointerInside.current = true;
          }}
          onPointerMove={() => {
            pointerInside.current = true;
          }}
          onPointerLeave={() => {
            pointerInside.current = false;
          }}
        >
          {children}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side={side ?? (appearance === "control" ? "top" : "bottom")}
            align="center"
            sideOffset={sideOffset}
            hideWhenDetached={hideWhenDetached}
            className={`message-action-tooltip${appearance === "control" ? " control-hint-tooltip" : ""}${className ? ` ${className}` : ""}`}
          >
            <span>
              {label}
              {shortcut && <kbd>{shortcut}</kbd>}
            </span>
            {description && <small>{description}</small>}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
export function CopyMessage({ text, onCopy }: { text: string; onCopy?: (text: string) => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 1200);
      return () => clearTimeout(timer);
    }
  }, [copied]);
  return (
    <MessageAction
      label={error ? "复制失败，点击重试" : "复制"}
      disabled={!text || !onCopy}
      onClick={() => {
        void onCopy?.(text).then(
          () => {
            setCopied(true);
            setError(false);
          },
          () => setError(true),
        );
      }}
    >
      {copied ? <Check size={14} className="message-copied" /> : <Copy size={14} />}
    </MessageAction>
  );
}
export function messageTime(timestamp: number, nowTimestamp = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const date = new Date(timestamp),
    now = new Date(nowTimestamp);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  if (sameDay(date, now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `昨天 ${time}`;
  return new Intl.DateTimeFormat("zh-CN", {
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
