import { CircleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

export function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (hovered || focused) return;
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [message, hovered, focused, onDismiss]);

  return (
    <div
      className="error-toast"
      role="alert"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <CircleAlert size={17} aria-hidden="true" />
      <span>{message}</span>
      <button type="button" aria-label="关闭错误" onClick={onDismiss}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
