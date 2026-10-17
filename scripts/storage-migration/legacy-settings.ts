import { isJsonObject } from "zpi-ai";
import {
  migrateShortcutDefaults,
  shortcutDefaultsVersion,
} from "../../packages/desktop/src/main/shortcut-defaults-migration.ts";
import type { SettingsData } from "../../packages/desktop/src/main/storage.ts";
import {
  defaultCapabilities,
  defaultPreferences,
  reasoningPresets,
} from "../../packages/desktop/src/shared/config.ts";
import {
  defaultShortcuts,
  normalizeShortcut,
  validateShortcuts,
  withQuickChatNewShortcut,
  withQuickChatShortcut,
  withTaskMenuShortcut,
} from "../../packages/desktop/src/shared/shortcuts.ts";

/** Read-only legacy adapter. No runtime fallback or writes to the source directory. */
export function migrateLegacySettings(value: unknown): SettingsData {
  if (!isJsonObject(value)) throw new Error("storage: Invalid settings record");
  const raw = structuredClone(value);
  if (raw.version !== undefined && ![1, 2, 3, 4].includes(raw.version as number))
    throw new Error("storage: Unsupported settings version");
  const version = raw.version ?? 1;
  if (version === 1 && ("apiKey" in raw || "headers" in raw))
    throw new Error("storage: Credentials must not be stored in public settings");
  let providers = raw.providers;
  if (version === 1) {
    providers = [
      {
        id: "custom",
        name: "Custom",
        baseUrl: raw.baseUrl,
        models: [
          {
            id: raw.modelId,
            input: raw.supportsImages ? ["text", "image"] : ["text"],
            reasoning: raw.reasoning ?? false,
            contextWindow: raw.contextWindow ?? 32768,
            maxTokens: raw.maxTokens ?? 4096,
            compat: { supportsReasoningEffort: false, ...(isJsonObject(raw.compat) ? raw.compat : {}) },
          },
        ],
      },
    ];
  }
  if (!Array.isArray(providers)) throw new Error("storage: Invalid providers");
  if (version === 1 || version === 2) {
    providers = providers.map((provider: unknown) => {
      if (!isJsonObject(provider) || !Array.isArray(provider.models))
        throw new Error("storage: Invalid provider record");
      return {
        ...provider,
        models: provider.models.map((model: unknown) => {
          if (!isJsonObject(model)) throw new Error("storage: Invalid model record");
          return {
            ...model,
            contextWindow: model.contextWindow ?? 32768,
            maxTokens: model.maxTokens ?? 4096,
            reasoning: model.reasoning ?? false,
            input: model.input ?? ["text"],
            compat: { supportsReasoningEffort: false, ...(isJsonObject(model.compat) ? model.compat : {}) },
          };
        }),
      };
    });
  }
  if (raw.capabilities != null && !isJsonObject(raw.capabilities))
    throw new Error("storage: Invalid plugin capabilities");
  if (raw.interface != null && !isJsonObject(raw.interface))
    throw new Error("storage: Invalid interface preferences");
  const preferences = {
    ...defaultPreferences,
    ...(isJsonObject(raw.interface) ? raw.interface : {}),
  } as Record<string, unknown>;
  delete preferences.askUserQuestionAutoResolutionEnabled;
  const sizes: Record<string, number> = { small: 12, default: 14, large: 16 };
  if (typeof preferences.fontSize === "string" && Object.hasOwn(sizes, preferences.fontSize))
    preferences.fontSize = sizes[preferences.fontSize];
  const data = {
    ...(version === 3 || version === 4 ? raw : {}),
    version: 4,
    providers,
    lastSelection: raw.lastSelection ?? null,
    templates: raw.templates ?? [],
    selectedTemplateId: raw.selectedTemplateId ?? "pi",
    disabledSkillPaths: raw.disabledSkillPaths ?? [],
    capabilities: { ...defaultCapabilities, ...(isJsonObject(raw.capabilities) ? raw.capabilities : {}) },
    interface: preferences,
    shortcuts: raw.shortcuts ?? defaultShortcuts(process.platform),
    shortcutDefaultsVersion,
  } as unknown as SettingsData;
  if (
    isJsonObject(raw.capabilities) &&
    raw.capabilities.communicationStyle !== undefined &&
    typeof raw.capabilities.communicationStyle !== "boolean"
  )
    throw new Error("storage: Invalid communication style capability");
  if (
    raw.shortcutDefaultsVersion !== undefined &&
    raw.shortcutDefaultsVersion !== 1 &&
    raw.shortcutDefaultsVersion !== shortcutDefaultsVersion
  )
    throw new Error("storage: Unsupported shortcut defaults version");
  data.shortcuts = withQuickChatNewShortcut(
    withQuickChatShortcut(withTaskMenuShortcut(data.shortcuts, process.platform), process.platform),
    process.platform,
  );
  const migrateShortcuts = raw.shortcutDefaultsVersion === undefined || raw.shortcutDefaultsVersion === 1;
  if (migrateShortcuts) {
    const bindings = data.shortcuts.bindings;
    if (isJsonObject(bindings) && !Object.hasOwn(bindings, "configure-environment"))
      bindings["configure-environment"] = null;
    if (isJsonObject(bindings) && !Object.hasOwn(bindings, "focus-composer")) {
      const focus = defaultShortcuts(process.platform).bindings["focus-composer"];
      bindings["focus-composer"] = Object.values(bindings).some(
        (binding) => typeof binding === "string" && normalizeShortcut(binding, process.platform) === focus,
      )
        ? null
        : focus;
    }
  }
  const shortcutError = validateShortcuts(data.shortcuts, process.platform);
  if (shortcutError) throw new Error(`storage: ${shortcutError}`);
  if (migrateShortcuts && raw.shortcuts != null)
    data.shortcuts = migrateShortcutDefaults(
      data.shortcuts,
      process.platform,
      raw.shortcutDefaultsVersion === 1 ? 1 : 0,
    );
  const selection = data.lastSelection;
  if (isJsonObject(selection)) {
    const model = data.providers
      .find((provider) => provider.id === selection.provider)
      ?.models.find((model) => model.id === selection.modelId);
    if (
      typeof selection.reasoning !== "string" ||
      !selection.reasoning.trim() ||
      (!model?.reasoningConfig && !(reasoningPresets as readonly string[]).includes(selection.reasoning))
    )
      data.lastSelection = null;
  }
  return data;
}
