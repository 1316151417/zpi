import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

/** Where the notice lives decides its layout and lifetime, not the caller. */
export type NoticeScope = "input" | "turn" | "window" | "config";
export type NoticeTone = "error" | "warning" | "info";

export interface NoticeAction {
  label: string;
  onClick: () => void;
}

export interface NoticeProps {
  scope: NoticeScope;
  tone?: NoticeTone;
  message: string;
  action?: NoticeAction;
  onDismiss?: () => void;
  dismissLabel?: string;
}

const icons = { error: CircleAlert, warning: TriangleAlert, info: Info } as const;

export function Notice({ scope, tone = "error", message, action, onDismiss, dismissLabel }: NoticeProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    // Only window notices are transient; input, turn and config notices stay until resolved.
    if (scope !== "window" || !onDismiss || hovered || focused) return;
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [scope, message, hovered, focused, onDismiss]);

  const Icon = icons[tone];
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: The notice exposes role=alert/status; hover only pauses the window timer.
    <div
      className={`notice notice-${scope} notice-${tone}`}
      data-notice-scope={scope}
      role={tone === "error" ? "alert" : "status"}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <Icon size={16} aria-hidden="true" />
      <span className="notice-message">{message}</span>
      {action && (
        <button type="button" className="notice-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="notice-dismiss"
          aria-label={dismissLabel ?? (tone === "error" ? "关闭错误" : "关闭提示")}
          onClick={onDismiss}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
