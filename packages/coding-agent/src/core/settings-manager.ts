// Settings subset adapted from Pi cd34e17ff039502f3664d8363b3c0a23f93a2ca3 (MIT).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "zpi-agent";
import {
  DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS,
  DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
  type Model,
  type RetryPolicy,
} from "zpi-ai";
import type { CompactionOptions, CompactionSettings } from "./compaction.ts";

export interface ProviderRetrySettings {
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
}
export interface RetrySettings extends Partial<RetryPolicy> {
  provider?: ProviderRetrySettings;
}
export interface Settings {
  defaultThinkingLevel?: ThinkingLevel;
  modelThinkingLevels?: Record<string, ThinkingLevel>;
  compaction?: CompactionOptions;
  retry?: RetrySettings;
  httpIdleTimeoutMs?: number | string;
  streamIdleTimeoutMs?: number;
  streamFirstResponseTimeoutMs?: number;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function merge(base: Settings, overrides: Settings): Settings {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    result[key] = object(result[key]) && object(value) ? merge(result[key], value) : value;
  }
  return result;
}
export class SettingsManager {
  private settings: Settings;
  private errors: { path: string; error: Error }[] = [];
  constructor(settings: Settings = {}) {
    this.settings = settings;
  }
  static inMemory(settings: Settings = {}): SettingsManager {
    return new SettingsManager(settings);
  }
  static create(cwd = process.cwd(), agentDir = join(homedir(), ".zpi", "agent")): SettingsManager {
    const manager = new SettingsManager();
    for (const path of [join(agentDir, "settings.json"), join(cwd, ".zpi", "settings.json")]) {
      try {
        const settings: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
        if (!object(settings)) throw new Error("Settings must be an object");
        manager.settings = merge(manager.settings, settings);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
        manager.errors.push({ path, error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
    return manager;
  }
  getErrors(): { path: string; error: Error }[] {
    return this.errors.slice();
  }
  applyOverrides(overrides: Settings): void {
    this.settings = merge(this.settings, overrides);
  }
  getDefaultThinkingLevel(): ThinkingLevel | undefined {
    return this.settings.defaultThinkingLevel;
  }
  getModelThinkingLevel(provider: string, id: string): ThinkingLevel | undefined {
    return this.settings.modelThinkingLevels?.[`${provider}/${id}`];
  }
  getCompactionSettings(model?: Pick<Model, "provider" | "id">): CompactionSettings {
    const config = this.settings.compaction;
    const key = model ? `${model.provider}/${model.id}` : undefined;
    const override = key === undefined ? undefined : config?.modelOverrides?.[key];
    if (override !== undefined && !object(override))
      throw new Error(`Invalid compaction.modelOverrides["${key}"] setting`);
    const resolve = (field: "reserveTokens" | "keepRecentTokens", fallback: number) => {
      for (const value of [config?.[field], override?.[field]])
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
          throw new Error(
            `Invalid compaction.${field} setting: ${String(value)}. Expected a non-negative safe integer.`,
          );
      return override?.[field] ?? config?.[field] ?? fallback;
    };
    return {
      enabled: config?.enabled ?? true,
      reserveTokens: resolve("reserveTokens", 16384),
      keepRecentTokens: resolve("keepRecentTokens", 20000),
    };
  }
  getMicrocompactSettings(): import("./microcompact.ts").MicrocompactConfig {
    return {
      ...this.settings.compaction?.microcompact,
      enabled:
        this.settings.compaction?.enabled !== false &&
        this.settings.compaction?.microcompact?.enabled === true,
    };
  }
  getRetrySettings(): RetryPolicy {
    const config = this.settings.retry;
    return {
      enabled: config?.enabled ?? true,
      maxRetries: config?.maxRetries ?? 10,
      baseDelayMs: config?.baseDelayMs ?? 2000,
      maxAgentDelayMs: config?.maxAgentDelayMs ?? 60000,
      maxElapsedMs: Number.isFinite(config?.maxElapsedMs) ? config?.maxElapsedMs : 600000,
    };
  }
  getProviderRetrySettings(): ProviderRetrySettings {
    return {
      ...this.settings.retry?.provider,
      maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
    };
  }
  getStreamIdleTimeoutMs(): number {
    const value = this.settings.streamIdleTimeoutMs;
    return value === undefined || !Number.isFinite(value) ? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS : value;
  }
  getStreamFirstResponseTimeoutMs(): number {
    // Preserve an explicit legacy single-window override for both phases.
    const value = this.settings.streamFirstResponseTimeoutMs ?? this.settings.streamIdleTimeoutMs;
    return value === undefined || !Number.isFinite(value) ? DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS : value;
  }
  getHttpIdleTimeoutMs(): number {
    const value = this.settings.httpIdleTimeoutMs;
    // The model-event watchdog is now the default. Retain explicit Pi HTTP timeout overrides.
    if (value === undefined) return 0;
    const normalized =
      typeof value === "string" && value.trim().toLowerCase() === "disabled"
        ? 0
        : typeof value === "number"
          ? value
          : typeof value === "string" && value.trim().length > 0
            ? Number(value.trim())
            : NaN;
    if (!Number.isFinite(normalized) || normalized < 0)
      throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(value)}`);
    return Math.floor(normalized);
  }
}
