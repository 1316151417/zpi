import type { InterfacePreferences } from "../shared/bridge.ts";
import { defaultPreferences } from "../shared/config.ts";
import { useStore } from "./store.ts";

export function startAppearance(): () => void {
  const media = matchMedia("(prefers-color-scheme: dark)");
  let preferences: InterfacePreferences = useStore.getState().settings?.interface ?? defaultPreferences;
  const apply = () => {
    const root = document.documentElement;
    root.dataset.theme =
      preferences.theme === "system" ? (media.matches ? "dark" : "light") : preferences.theme;
    root.style.setProperty("--ui-font-size", `${preferences.fontSize}px`);
  };
  const systemChanged = () => {
    if (preferences.theme === "system") apply();
  };
  apply();
  media.addEventListener("change", systemChanged);
  const unsubscribe = useStore.subscribe((state) => {
    const next = state.settings?.interface ?? defaultPreferences;
    if (next.theme === preferences.theme && next.fontSize === preferences.fontSize) return;
    preferences = next;
    apply();
  });
  return () => {
    unsubscribe();
    media.removeEventListener("change", systemChanged);
  };
}
