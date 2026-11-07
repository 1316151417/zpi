/** Native host integration uses the same engine while retaining indexed history and projections. */

export type {
  AgentSession,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  InputContext,
  ParsedInput,
  ResourceLoader,
  SessionPlugin,
  ToolDefinition,
} from "zpi-coding-agent";
export { createAgentSession, SessionManager, SettingsManager } from "zpi-coding-agent";
