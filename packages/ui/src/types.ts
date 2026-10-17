import type { ThinkingLevel } from "zpi-agent";
import type { Message, ModelRetryStatus, ToolCall, ToolResultMessage } from "zpi-ai";
import type { Attachment, ContextUsage, ModelPerformance, ResourceDiagnostic } from "zpi-coding-agent";
import type { FileLocation } from "./link-target.ts";
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
export interface WebSearchSource {
  title: string;
  url: string;
  snippet: string;
  summary?: string;
  site_name: string | null;
  site_icon: string | null;
  date: string | null;
}
export interface WebToolDetails {
  kind: "web_search" | "web_fetch";
  status: "pending" | "success" | "error" | "cancelled";
  query?: string;
  url?: string;
  title?: string;
  content?: string;
  results?: WebSearchSource[];
  truncated?: boolean;
  message?: string;
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
      questionAnswers?: UserQuestionResponse;
      web?: WebToolDetails;
    };
export interface SubagentNotification {
  agentId: string;
  agentType: string;
  description: string;
}
export interface RunView {
  /** This page starts inside a run; its original input is on an older page. */
  historyContinuation?: boolean;
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
  preparation?: string | null;
}
export interface SubagentTask {
  agentId: string;
  childSessionId: string;
  parentSessionId: string;
  parentToolCallId: string;
  agentType: string;
  description: string;
  color: string;
  background: boolean;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  modelLabel: string;
  totalToolUseCount: number;
  totalTokens: number;
  result?: string;
  error?: string;
  latestActivity?: string;
  waitingForInput?: boolean;
}
export interface BackgroundTask {
  taskId: string;
  sessionId: string;
  toolCallId: string;
  command: string;
  description: string;
  status: "running" | "completed" | "failed" | "cancelled" | "lost";
  startedAt: number;
  endedAt?: number;
  pid?: number;
  exitCode?: number | null;
  outputPath: string;
  error?: string;
  autoBackgrounded?: boolean;
}
export interface BackgroundTaskOutput {
  task: BackgroundTask;
  output: string;
  truncated: boolean;
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
export interface UserQuestion {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
}
export interface UserQuestionRequest {
  id: string;
  questions: UserQuestion[];
  autoResolution?:
    | { phase: "hiddenGrace" | "visibleCountdown"; startedAt: number; visibleAt: number; deadlineAt: number }
    | { phase: "snoozed"; startedAt: number; snoozedAt: number };
}
export interface UserQuestionResponse {
  answers: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
}
