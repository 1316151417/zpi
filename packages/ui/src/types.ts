import type { ThinkingLevel } from "zpi-agent";
import type { Message, ToolCall, ToolResultMessage } from "zpi-ai";
import type { ContextUsage, ImageAttachment, ResourceDiagnostic } from "zpi-coding-agent";
export interface SessionControls {
  selection: {
    provider: string;
    modelId: string;
    reasoning: string;
  } | null;
  presets: string[];
  selectionValid: boolean;
  model: { provider: string; modelId: string } | null;
  thinkingLevel: ThinkingLevel;
  lastThinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  usage: ContextUsage;
  diagnostics: ResourceDiagnostic[];
}
export interface InputSuggestion {
  name: string;
  description: string;
  insert: string;
  group: "命令" | "Skill";
}
export type RunStatus = "running" | "completed" | "aborted" | "error" | "interrupted";
export interface FileChangeSummary {
  path: string;
  additions?: number;
  deletions?: number;
  failed?: boolean;
  reason?: string;
}
export type ViewBlock =
  | {
      id: string;
      messageId: string;
      type: "text" | "thinking";
      text: string;
      streaming?: boolean;
      startedAt?: number;
      endedAt?: number;
    }
  | {
      id: string;
      messageId: string;
      type: "tool";
      toolCallId: string;
      name: string;
      argsText: string;
      status: "preparing" | "running" | "completed" | "error";
      output: string;
      isError?: boolean;
      hasFileChange?: boolean;
      fileChange?: FileChangeSummary;
    };
export interface RunView {
  runId: string;
  status: RunStatus;
  userMessage: string;
  fileReferences?: string[];
  attachments?: ImageAttachment[];
  orderedBlocks: ViewBlock[];
  finalAnswerBlockIds: string[];
  startedAt: number;
  endedAt?: number;
  error?: string;
  modelLabel?: string;
  notice?: string;
}
export interface SessionView {
  sessionId: string;
  title: string;
  seq: number;
  runs: RunView[];
  controls?: SessionControls;
  queue?: InputQueue;
}
export interface QueuedInput {
  id: string;
  text: string;
  fileReferences: string[];
  attachments: ImageAttachment[];
  selection: NonNullable<SessionControls["selection"]>;
  state: "queued" | "dispatching";
}
export interface InputQueue {
  items: QueuedInput[];
  autoDrain: boolean;
  pauseReason?: "stopped" | "error" | "restart";
  error?: string;
}
export type DesktopEvent =
  | { type: "queue_changed"; queue: InputQueue }
  | { type: "session_changed"; title: string }
  | { type: "controls_changed"; controls: SessionControls }
  | { type: "notice"; text: string }
  | { type: "block_end"; messageId: string; contentIndex: number; timestamp?: number }
  | {
      type: "started";
      text: string;
      fileReferences?: string[];
      attachments?: ImageAttachment[];
      startedAt: number;
      modelLabel: string;
    }
  | {
      type: "settled";
      status: Exclude<RunStatus, "running">;
      endedAt: number;
      error?: string;
      unreadAt?: number;
    }
  | { type: "message_start"; messageId: string; role: Message["role"] }
  | {
      type: "block_start";
      messageId: string;
      contentIndex: number;
      kind: "text" | "thinking" | "tool";
      timestamp?: number;
      toolCall?: ToolCall;
    }
  | { type: "block_delta"; messageId: string; contentIndex: number; delta: string }
  | { type: "tool_ready"; messageId: string; contentIndex: number; toolCall: ToolCall }
  | { type: "message_end"; messageId: string; message: Message; timestamp?: number }
  | { type: "tool_start"; toolCallId: string; name: string; argsText: string }
  | {
      type: "tool_update" | "tool_end";
      toolCallId: string;
      output: string;
      isError?: boolean;
      hasFileChange?: boolean;
      fileChange?: FileChangeSummary;
    };
export interface DesktopEventEnvelope {
  sessionId: string;
  runId: string;
  seq: number;
  event: DesktopEvent;
}
export function resultText(message: Pick<ToolResultMessage, "content">): string {
  return message.content.map((c) => (c.type === "text" ? c.text : "[Image]")).join("\n");
}
