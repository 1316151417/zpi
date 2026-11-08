import type { JsonObject } from "@zpi-dev/ai";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "../core/types.ts";
import type { HookRegistration } from "./hooks.ts";

export interface PluginCommand {
  name: string;
  description: string;
  /** Literal prompt template; only {{cwd}} and {{arguments}} are expanded once. */
  prompt: string;
}
export interface PluginSkill {
  name: string;
  description: string;
  path: string;
  baseDir: string;
  body: string;
}

/** Serializable contributions frozen by a host at first-send admission. */
export interface PluginSnapshot {
  id: string;
  version: string;
  name?: string;
  description?: string;
  instructions?: readonly string[];
  commands?: readonly PluginCommand[];
  skills?: readonly PluginSkill[];
  /** Host-resolved runtime identity, never an import path. */
  runtime?: string;
  options?: JsonObject;
}
export type PluginMetadata = Pick<PluginSnapshot, "id" | "version" | "name" | "description">;

/** Explicit native registration. Discovery never imports arbitrary workspace code. */
export interface SessionPlugin extends PluginSnapshot {
  tools?: readonly ToolDefinition<TSchema, unknown>[];
  /** Explicitly replace an existing built-in; collisions are rejected during assembly. */
  toolOverrides?: readonly ToolDefinition<TSchema, unknown>[];
  /** Pure synchronous context reader, evaluated for previews and after prompt hooks/resource refresh. */
  contextInstructions?: () => readonly string[];
  hooks?: readonly HookRegistration[];
}
