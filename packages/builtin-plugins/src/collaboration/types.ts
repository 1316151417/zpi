import type { CombinedSelection } from "../types.ts";

export const agentColors = ["yellow", "red", "orange", "green", "cyan", "blue", "purple", "pink"] as const;
export type AgentColor = (typeof agentColors)[number];
export interface SubagentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  color: AgentColor;
  modelSelection?: CombinedSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd: boolean;
}
export interface SubagentProfile extends SubagentConfig {
  id: string;
  scope: "built-in" | "user" | "workspace" | "plugin";
  enabled: boolean;
  path?: string;
}
/** Only directory information exposed to the parent, never an unread role prompt or launch configuration. */
export type SubagentSummary = Pick<
  SubagentProfile,
  "id" | "name" | "description" | "scope" | "enabled" | "path"
>;
export function summarizeSubagent(profile: SubagentSummary): SubagentSummary {
  const { id, name, description, scope, enabled, path } = profile;
  return { id, name, description, scope, enabled, path };
}
export interface SubagentCatalog {
  agents: SubagentProfile[];
  diagnostics: { path: string; message: string }[];
}
export interface SaveSubagentInput {
  id?: string;
  config: SubagentConfig;
  scope: "user" | "workspace";
  sessionId: string | null;
}
