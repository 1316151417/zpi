import type { ImageContent, Model } from "zpi-ai";
import type {
  AgentSession,
  IndexedSessionEntry,
  ModelRuntime,
  PluginSnapshot,
  SessionEntry,
  TranscriptSnapshot,
} from "zpi-coding-agent";
import type { SubagentProfile } from "./collaboration/types.ts";
import type { MemoryInheritance, MemorySettings } from "./memory/types.ts";
import type {
  BackgroundTask,
  CombinedSelection,
  PluginNotification,
  SubagentNotification,
  SubagentTask,
  UserQuestionRequest,
} from "./types.ts";

export interface PluginStorage {
  getSetting<T>(key: string): T | undefined;
  setSetting(key: string, value: unknown): void;
}
export interface PluginHistory {
  snapshot(): TranscriptSnapshot;
  readReverse(snapshot: TranscriptSnapshot): Iterable<IndexedSessionEntry>;
  readRange(
    start: number,
    end: number,
    snapshot: TranscriptSnapshot,
    types?: readonly SessionEntry["type"][],
  ): Iterable<IndexedSessionEntry>;
}
export interface PluginSessionRecord {
  id: string;
  projectId: string | null;
  parentSessionId?: string;
  draft?: boolean;
  archivedAt?: number | null;
  diagnostic?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
export interface PluginConfiguration extends MemoryInheritance {
  plugins: PluginSnapshot[];
  subagentProfile?: SubagentProfile;
  subagentInstructions?: string[];
}
export interface PluginModelInput {
  text: string;
  images: ImageContent[];
  model: Model;
  runtime(): Promise<ModelRuntime>;
}
export interface PluginRun {
  runId: string;
  done: Promise<void>;
  aborted?: boolean;
  session?: Pick<AgentSession, "steer">;
  modelInput?: PluginModelInput;
}
export interface PluginInput {
  sessionId: string;
  text: string;
  subagentNotification?: SubagentNotification;
  backgroundNotification?: boolean;
  deliveryId?: string;
  agentMessageKind?: "reply" | "notification";
  receivedDuringRun?: string;
}
export type PluginEvent =
  | { type: "question_changed"; question: UserQuestionRequest | null }
  | { type: "background_task_changed"; task: BackgroundTask }
  | { type: "subagent_changed"; task: SubagentTask };
export interface PluginRuntimeState {
  kind: string;
  status: string;
  data: unknown;
}

/** Host adapters expose platform services; plugin scheduling and policy live in this package. */
export interface BuiltinPluginPorts {
  directory: string;
  homeDirectory: string;
  storage: PluginStorage & {
    setRuntime(id: string, kind: string, instanceId: string, data: unknown, status?: string): void;
  };
  sessions: {
    get(id: string): PluginSessionRecord | undefined;
    records(): Iterable<PluginSessionRecord>;
    cwd(id: string): string;
    configuration(id: string): PluginConfiguration;
    configure(id: string, patch: Partial<PluginConfiguration>): void;
    state(id: string): { titleState?: string } | undefined;
    update(id: string, patch: { title?: string; titleState?: string; draft?: boolean }): void;
    createChild(parentId: string): Promise<string>;
    delete(id: string): Promise<void>;
    select(id: string, selection: CombinedSelection): void;
    run(input: PluginInput, internal: boolean): Promise<void>;
    active(id: string): PluginRun | undefined;
    stop(id: string): Promise<void>;
    closed(id: string): boolean;
    deleting(id: string): boolean;
    changing(id: string): boolean;
    blocked(id: string): boolean;
    history(id: string): PluginHistory;
  };
  models: {
    valid(selection: CombinedSelection): boolean;
    selection(id: string | null): CombinedSelection | null;
    create(selection: CombinedSelection): { runtime: ModelRuntime; model: Model };
  };
  memorySettings(): MemorySettings;
  files: {
    preview(id: string | null, path: string): Promise<{ kind: string; text?: string }>;
  };
  credentials(name: "webSearch"): string;
  fetch?: typeof fetch;
  closing(): boolean;
  publish(id: string, channel: string, event: PluginEvent): void;
  titleChanged(id: string, title: string, generated: boolean): void;
  notify(request: PluginNotification): boolean;
  error(scope: string, error: unknown, context?: Record<string, string | number | boolean | undefined>): void;
}
