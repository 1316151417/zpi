import type { CombinedSelection } from "./bridge.ts";

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
  scope: "built-in" | "user" | "workspace";
  enabled: boolean;
  path?: string;
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
