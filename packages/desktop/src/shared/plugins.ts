import { desktopPluginIds } from "@zpi-dev/builtin-plugins";
import type { PublicSettings } from "./bridge.ts";

export function memoryMode(plugins: PublicSettings["plugins"]): "off" | "short" | "long" {
  if (plugins.enabled[desktopPluginIds.memory] === false) return "off";
  const mode = plugins.options[desktopPluginIds.memory]?.mode;
  return mode === "short" || mode === "long" ? mode : "off";
}

export function webSearchAvailable(settings: Pick<PublicSettings, "plugins" | "webSearch">): boolean {
  return (
    settings.plugins.enabled[desktopPluginIds.web] === true &&
    settings.webSearch.enabled &&
    settings.webSearch.hasApiKey &&
    !settings.webSearch.credentialsLocked
  );
}
