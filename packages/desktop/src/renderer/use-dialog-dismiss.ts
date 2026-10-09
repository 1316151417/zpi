import { useEffect, useRef, useState } from "react";

// Keep conditionally mounted dialogs alive for Radix's 100ms exit animation.
export function useDialogDismiss(onClosed: () => void) {
  const [open, setOpen] = useState(true);
  const callback = useRef(onClosed);
  callback.current = onClosed;
  useEffect(() => {
    if (open) return;
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 100;
    const timer = setTimeout(() => callback.current(), delay);
    return () => clearTimeout(timer);
  }, [open]);
  return [open, () => setOpen(false)] as const;
}
