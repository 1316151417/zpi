import type { HookEvent } from "zpi-coding-agent";

export const configurableHookEvents: readonly HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "InputAccepted",
  "RunStart",
  "RunEnd",
  "Notification",
];
export interface HookConfig {
  event: HookEvent;
  type: "process" | "command";
  command: string;
  args: string[];
  matcher?: string;
  timeoutMs: number;
  enabled: boolean;
}
export interface ConfiguredHook extends HookConfig {
  id: string;
  projectId: string | null;
  revision: string;
}
export interface SaveHookInput extends HookConfig {
  projectId: string | null;
  id?: string;
  expectedRevision?: string;
}
export interface HookTarget {
  projectId: string | null;
  id: string;
  expectedRevision: string;
}
export interface PluginHookDetail {
  event: HookEvent;
  type: "native" | "process" | "command";
  command: string;
  args?: string[];
  matcher?: string;
  timeoutMs?: number;
}
export interface PluginHookGroup {
  id: string;
  name: string;
  enabled: boolean;
  builtin: boolean;
  hooks: PluginHookDetail[];
}
export interface HooksCatalog {
  hooks: ConfiguredHook[];
  plugins: PluginHookGroup[];
}
