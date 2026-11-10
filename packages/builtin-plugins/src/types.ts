export interface ModelSelection {
  provider: string;
  modelId: string;
}
export interface PluginNotification {
  sessionId: string;
  title: string;
  body: string;
}
export type ReasoningPreset = string;
export interface CombinedSelection extends ModelSelection {
  reasoning: ReasoningPreset;
  fastMode?: boolean;
}

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
export interface SubagentTask {
  prompt?: string;
  outputFile?: string;
  taskOutputFile?: string;
  metadataFile?: string;
  spawnToolCallId?: string;
  cwd?: string;
  tokensReported?: boolean;
  usage?: Record<string, number>;
  agentId: string;
  childSessionId: string;
  parentSessionId: string;
  parentToolCallId: string;
  agentType: string;
  description: string;
  color: string;
  background: boolean;
  status: "running" | "completed" | "aborted" | "error" | "interrupted";
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

export interface SubagentNotification {
  agentId: string;
  agentType: string;
  description: string;
}
