/** Native host integration uses the same engine while retaining indexed history and projections. */

export type {
  AgentSession,
  ContextUsage,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  IndexedSessionEntry,
  InputContext,
  ParsedInput,
  ResourceLoader,
  SessionCurrentState,
  SessionEntry,
  SessionHeader,
  SessionPlugin,
  ToolDefinition,
  TranscriptContextPlan,
  TranscriptSnapshot,
  TranscriptState,
  TranscriptStore,
} from "@zpi-dev/coding-agent";
export { createAgentSession, SessionManager, SettingsManager } from "@zpi-dev/coding-agent";

export { nativeStopReason, queryResult } from "./query-result.ts";
