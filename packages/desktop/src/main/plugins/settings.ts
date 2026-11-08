import { isJsonObject } from "@zpi-dev/ai";
import { type defaultPluginSettings, validateBuiltinPluginOptions } from "@zpi-dev/builtin-plugins";

export function validatePluginSettings(value: unknown): asserts value is typeof defaultPluginSettings {
  if (
    !isJsonObject(value) ||
    value.version !== 2 ||
    Object.keys(value).some((key) => !["version", "enabled", "options"].includes(key)) ||
    !isJsonObject(value.enabled) ||
    Object.entries(value.enabled).some(
      ([id, enabled]) => !/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]*$/.test(id) || typeof enabled !== "boolean",
    ) ||
    !isJsonObject(value.options)
  )
    throw new Error("storage: Invalid plugin settings");
  for (const [id, options] of Object.entries(value.options)) {
    if (!isJsonObject(options)) throw new Error("storage: Invalid plugin options");
    validateBuiltinPluginOptions(id, options);
  }
}
