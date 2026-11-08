import type { ThinkingLevel } from "@zpi-dev/agent";
import type { Message, ModelRetryStatus, ModelWaitStatus, ToolCall, ToolResultMessage } from "@zpi-dev/ai";
import type {
  BackgroundTask,
  CombinedSelection,
  ModelSelection,
  SubagentNotification,
  SubagentTask,
  UserQuestionRequest,
  UserQuestionResponse,
  WebToolDetails,
} from "@zpi-dev/builtin-plugins/types";
import type { Attachment, ContextUsage, ModelPerformance, ResourceDiagnostic } from "@zpi-dev/coding-agent";
import type { FileLocation } from "./link-target.ts";

export type {
  BackgroundTask,
  BackgroundTaskOutput,
  SubagentNotification,
  SubagentTask,
  UserQuestion,
  UserQuestionRequest,
  UserQuestionResponse,
  WebSearchSource,
  WebToolDetails,
} from "@zpi-dev/builtin-plugins/types";
export interface SessionControls {
  selection: CombinedSelection | null;
  presets: string[];
  selectionValid: boolean;
  model: ModelSelection | null;
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
  group: "命令" | "Skill" | "子智能体" | "对话";
  customCommand?: boolean;
  argumentHint?: string;
}
export interface SessionMentionSuggestion extends InputSuggestion {
  sessionId: string;
  workspaceKey: string;
  keywords: string[];
}
export type RunStatus = "running" | "completed" | "aborted" | "error" | "interrupted";
export interface CompactionView {
  id: string;
  status: RunStatus | "noop";
  origin: "manual" | "auto";
  afterBlockId?: string;
  error?: string;
}
export interface FileChangeSummary {
  path: string;
  patch?: string;
  patchAvailable?: boolean;
  additions?: number;
  deletions?: number;
  failed?: boolean;
  reason?: string;
}
export type FileAction = "open" | "reveal" | "copy-absolute" | "copy-relative";
export interface WorktreeInfo {
  id?: string;
  /** Branch recorded by older sessions; new worktrees start with a detached HEAD. */
  branch?: string;
  path: string;
  sourceCwd: string;
}
export type FileActionHandler = (path: string, action: FileAction, location?: FileLocation) => Promise<void>;
export type ViewBlock =
  | {
      id: string;
      messageId: string;
      type: "text" | "thinking";
      text: string;
      streaming?: boolean;
      interrupted?: boolean;
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
      questionAnswers?: UserQuestionResponse;
      web?: WebToolDetails;
    };
export interface RunView {
  /** This page starts inside a run; its original input is on an older page. */
  historyContinuation?: boolean;
  guides?: ({ id: string; afterBlockId?: string } & import("@zpi-dev/ai").UserGuide)[];
  subagentNotification?: SubagentNotification;
  runId: string;
  status: RunStatus;
  userMessage: string;
  fileReferences?: string[];
  attachments?: Attachment[];
  orderedBlocks: ViewBlock[];
  finalAnswerBlockIds: string[];
  startedAt: number;
  endedAt?: number;
  error?: string;
  modelLabel?: string;
  notice?: string;
  kind?: "compact";
  compactions?: CompactionView[];
  apiRetry?: ModelRetryStatus | null;
  modelWait?: ModelWaitStatus | null;
  preparation?: string | null;
  /** Failed assistant awaiting a retry; retained until the replacement starts. */
  failedMessageId?: string;
}
export interface SessionView {
  modelPerformance?: ModelPerformance;
  backgroundTasks?: BackgroundTask[];
  subagents?: SubagentTask[];
  question?: UserQuestionRequest | null;
  forkOrigin?: { sessionId: string; runId: string };
  sessionId: string;
  title: string;
  seq: number;
  runs: RunView[];
  controls?: SessionControls;
  queue?: InputQueue;
}
export interface QueuedInput {
  subagentNotification?: SubagentNotification;
  id: string;
  text: string;
  fileReferences: string[];
  attachments: Attachment[];
  selection: NonNullable<SessionControls["selection"]>;
  state: "queued" | "dispatching";
  /** Legacy marker from 0.2.232–0.2.233, read only for recovery deduplication. */
  delivery?: "guide";
}
export interface InputQueue {
  items: QueuedInput[];
  autoDrain: boolean;
  pauseReason?: "stopped" | "error" | "restart";
  error?: string;
}
export type DesktopEvent =
  | { type: "model_performance"; performance: ModelPerformance }
  | { type: "background_task_changed"; task: BackgroundTask }
  | { type: "subagent_changed"; task: SubagentTask }
  | { type: "run_preparation"; message: string | null }
  | { type: "environment_changed"; cwd: string; newWorktree: boolean; worktree: WorktreeInfo }
  | { type: "question_changed"; question: UserQuestionRequest | null }
  | ({ type: "compaction" } & Omit<CompactionView, "afterBlockId">)
  | { type: "model_retry"; status: ModelRetryStatus | null }
  | { type: "model_wait"; status: ModelWaitStatus | null }
  | { type: "message_reset"; messageId: string }
  | { type: "history_reset"; view: SessionView }
  | { type: "queue_changed"; queue: InputQueue }
  | { type: "session_changed"; title: string }
  | { type: "controls_changed"; controls: SessionControls }
  | { type: "notice"; text: string }
  | { type: "block_end"; messageId: string; contentIndex: number; timestamp?: number }
  | {
      type: "started";
      historyContinuation?: boolean;
      subagentNotification?: SubagentNotification;
      text: string;
      fileReferences?: string[];
      attachments?: Attachment[];
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
      questionAnswers?: UserQuestionResponse;
      web?: WebToolDetails;
    };
export interface DesktopEventEnvelope {
  /** Host event time for conversation activity; metadata envelopes omit it. */
  activityAt?: number;
  sessionId: string;
  runId: string;
  seq: number;
  event: DesktopEvent;
}
export function resultText(message: Pick<ToolResultMessage, "content">): string {
  return message.content.map((c) => (c.type === "text" ? c.text : "[Image]")).join("\n");
}
export interface FileRewindConflict {
  path: string;
  reason: string;
  ignored?: boolean;
}
