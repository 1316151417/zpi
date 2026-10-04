import { useSyncExternalStore } from "react";

// One effective appearance for CSS, native surfaces and rendered artifacts.
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;
export function observeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}
const snapshot = () =>
  `${document.documentElement.dataset.theme ?? "light"}:${document.documentElement.style.getPropertyValue("--ui-font-size") || "14px"}`;
export function useAppearance() {
  const value = useSyncExternalStore(observeAppearance, snapshot, () => "light:14px");
  const [theme, fontSize] = value.split(":");
  return { theme: theme === "dark" ? ("dark" as const) : ("light" as const), fontSize };
}
