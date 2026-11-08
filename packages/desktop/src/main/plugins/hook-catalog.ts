import { builtinPluginCatalog, builtinPluginHooks, defaultPluginSettings } from "@zpi-dev/builtin-plugins";
import type { HookEvent, PluginSnapshot } from "@zpi-dev/coding-agent";
import type { CommandHook } from "@zpi-dev/plugin-compat";
import type { PublicSettings } from "../../shared/bridge.ts";
import type { PluginHookGroup } from "../../shared/hooks.ts";

/** Data-only projection. Listing hooks never binds tools or runs plugin code. */
export function pluginHookGroups(
  settings: PublicSettings["plugins"],
  local: PluginSnapshot[],
): PluginHookGroup[] {
  return [...builtinPluginCatalog, ...local].flatMap((plugin) => {
    const builtin = builtinPluginCatalog.some((entry) => entry.id === plugin.id);
    const snapshot = { ...plugin, options: settings.options[plugin.id] ?? plugin.options };
    const hooks = builtin
      ? builtinPluginHooks(snapshot).map(({ event, matcher, description }) => ({
          event,
          matcher,
          type: "native" as const,
          command: description,
        }))
      : ((plugin.options?.hooks ?? []) as unknown as CommandHook[]).map((hook) => ({
          ...hook,
          event: hook.event as HookEvent,
        }));
    return hooks.length
      ? [
          {
            id: plugin.id,
            name: plugin.name ?? plugin.id,
            builtin,
            enabled: settings.enabled[plugin.id] ?? defaultPluginSettings.enabled[plugin.id] ?? false,
            hooks,
          },
        ]
      : [];
  });
}
