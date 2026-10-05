import type { Model, ModelDiscoveryResult, OpenAICompletionsCompat, ProviderPresetId } from "zpi-ai";
import type { DiscoveredSkill, ImageAttachment, SkillList } from "zpi-coding-agent";
import type { DesktopEventEnvelope, QueuedInput, RunStatus, SessionControls, SessionView } from "zpi-ui";
import type { FileLocation } from "zpi-ui/links";

export type { SessionControls } from "zpi-ui";
export type ErrorCode = "configuration" | "busy" | "not_found" | "provider" | "storage" | "invalid_input";
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: ErrorCode; message: string } };
export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  updatedAt: number;
  hidden?: boolean;
}
export interface SessionRecord {
  draft?: boolean;
  id: string;
  projectId: string | null;
  cwd?: string;
  pinnedAt?: number | null;
  archivedAt?: number | null;
  unreadAt?: number;
  diagnostic?: string;
  title: string;
  status?: RunStatus;
  updatedAt: number;
}
export interface SettingsInput {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  headers?: Record<string, string>;
  supportsImages: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  compat?: OpenAICompletionsCompat;
}
export interface ModelSettings {
  enabled?: boolean;
  useRecommendedConfig?: boolean;
  metadataSource?: "remote" | "catalog" | "defaults";
  id: string;
  name?: string;
  input?: ("text" | "image" | "video" | "pdf")[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  compat?: OpenAICompletionsCompat;
  thinkingLevelMap?: Model["thinkingLevelMap"];
  reasoningConfig?: Model["reasoningConfig"];
  defaultThinkingLevel?: Model["defaultThinkingLevel"];
  availability?: "listed" | "unverified";
  samplingParams?: Model["samplingParams"];
}
export interface ProviderInput {
  enabled?: boolean;
  preset?: ProviderPresetId;
  id?: string;
  name: string;
  baseUrl: string;
  models: ModelSettings[];
  apiKey?: string;
}
export interface ProviderRecord extends Omit<ProviderInput, "apiKey" | "id"> {
  id: string;
  hasApiKey: boolean;
  chatgptAccount?: { label: string; connected: boolean };
}
export interface ModelSelection {
  provider: string;
  modelId: string;
}
export type ReasoningPreset = string;
export interface CombinedSelection extends ModelSelection {
  reasoning: ReasoningPreset;
}
export interface InterfacePreferences {
  theme: "system" | "light" | "dark";
  fontSize: number;
  showContextUsage: boolean;
  showSendButton: boolean;
  notificationEnabled: boolean;
  notificationSoundEnabled: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  collapsedProjectIds: string[];
  projectsCollapsed: boolean;
  tasksCollapsed: boolean;
}
export interface PublicSettings {
  providers: ProviderRecord[];
  lastSelection: CombinedSelection | null;
  interface: InterfacePreferences;
  credentialsPersisted: boolean;
  disabledSkillPaths: string[];
}
export interface SessionSnapshot {
  session: SessionRecord;
  view: SessionView;
  seq: number;
  controls: SessionControls;
  historyCursor?: number | null;
}
export interface RunInput {
  sessionId: string;
  text: string;
  fileReferences?: string[];
  attachments?: string[];
}
export interface WorkspaceInfo {
  home: string;
  cwd: string;
  projectName: string;
  projectId: string | null;
}
export interface PromptPreview {
  cwd: string;
  projectName: string;
  basePrompt: string;
  systemRules: string;
  prompt: string;
}
export interface DiffItem {
  id: string;
  path: string;
  oldPath?: string;
  status: string;
  area: string;
  patch?: string;
  patchAvailable?: boolean;
  reason?: string;
  failed?: boolean;
}
export interface ToolInfo {
  name: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  enabled: boolean;
}
export interface SkillSettings {
  skills: DiscoveredSkill[];
  diagnostics: { path: string; message: string }[];
  directories: string[];
}
export interface TextDraft {
  text: string;
  fileReferences: string[];
  selection: [number, number];
  revision: number;
}
export type FilePreview = { location?: FileLocation } & (
  | { path: string; kind: "text"; text: string; truncated: boolean }
  | { path: string; kind: "image" | "media" | "xlsx" | "docx"; bytes: Uint8Array; mime?: string }
  | { path: string; kind: "unsupported" }
);
export interface BrowserState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  back: boolean;
  forward: boolean;
  error?: string;
}
export type PaneEvent =
  | { type: "terminal"; id: string; data: string; exited?: boolean }
  | { type: "browser"; state: BrowserState };
export interface PaneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface DesktopBridge {
  readonly platform: string;
  onTaskNotificationClick(listener: (sessionId: string) => void): () => void;
  onTaskNotificationSound(listener: () => void): () => void;
  archiveSession(id: string): Promise<Result<void>>;
  listArchivedSessions(): Promise<Result<(SessionRecord & { projectName: string })[]>>;
  restoreSession(id: string): Promise<Result<SessionRecord>>;
  openSessionDirectory(id: string): Promise<Result<void>>;
  createTerminal(sessionId: string): Promise<Result<{ id: string; shell: string }>>;
  terminalInput(id: string, data: string): Promise<Result<void>>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<Result<void>>;
  closeTerminal(id: string): Promise<Result<void>>;
  createBrowser(url: string): Promise<Result<BrowserState>>;
  browserAction(
    id: string,
    action: "navigate" | "back" | "forward" | "reload" | "stop",
    url?: string,
  ): Promise<Result<void>>;
  browserBounds(id: string, bounds: PaneBounds | null): Promise<Result<void>>;
  closeBrowser(id: string): Promise<Result<void>>;
  onPaneEvent(listener: (event: PaneEvent) => void): () => void;
  getDraft(id: string): Promise<Result<TextDraft & { warnings: string[] }>>;
  saveDraft(id: string, draft: TextDraft): Promise<Result<void>>;
  getHistoryPage(
    id: string,
    before: number,
  ): Promise<Result<{ view: SessionView; cursor: number | null; calls: number }>>;
  copyText(text: string): Promise<Result<void>>;
  searchFiles(
    sessionId: string,
    query: string,
  ): Promise<Result<{ path: string; name: string; absolutePath: string }[]>>;
  getWorkspaceInfo(sessionId: string | null): Promise<Result<WorkspaceInfo>>;
  downloadImage(src: string): Promise<Result<void>>;
  readFilePreview(sessionId: string, path: string, location?: FileLocation): Promise<Result<FilePreview>>;
  importImage(sessionId: string, name: string, bytes: Uint8Array): Promise<Result<ImageAttachment>>;
  pickImages(sessionId: string): Promise<Result<ImageAttachment[]>>;
  readAttachment(sessionId: string, id: string): Promise<Result<{ metadata: ImageAttachment; data: string }>>;
  removeAttachment(sessionId: string, id: string): Promise<Result<void>>;
  getChanges(sessionId: string, runId: string | null): Promise<Result<DiffItem[]>>;
  readPatch(sessionId: string, runId: string | null, id: string): Promise<Result<string>>;
  previewPrompt(): Promise<Result<PromptPreview>>;
  listTools(): Promise<Result<ToolInfo[]>>;
  getSkillSettings(): Promise<Result<SkillSettings>>;
  readSkill(path: string): Promise<Result<string>>;
  setSkillEnabled(path: string, enabled: boolean): Promise<Result<PublicSettings>>;
  listProjects(): Promise<Result<ProjectRecord[]>>;
  addProject(): Promise<Result<ProjectRecord | null>>;
  removeProject(id: string): Promise<Result<void>>;
  listSessions(projectId: string): Promise<Result<SessionRecord[]>>;
  listRecentSessions(): Promise<Result<SessionRecord[]>>;
  createSession(projectId: string | null): Promise<Result<SessionRecord>>;
  activateSession(sessionId: string): Promise<Result<SessionRecord>>;
  setSessionPinned(sessionId: string, pinned: boolean): Promise<Result<SessionRecord>>;
  getSessionSnapshot(sessionId: string): Promise<Result<SessionSnapshot>>;
  renameSession(id: string, name: string): Promise<Result<SessionRecord>>;
  deleteSession(id: string): Promise<Result<void>>;
  startRun(input: RunInput): Promise<Result<{ runId: string }>>;
  submitInput(
    input: RunInput & { queueDisposition?: "keep" | "clear" },
  ): Promise<Result<{ runId?: string; queueItemId?: string; confirmationRequired?: true }>>;
  editQueuedInput(
    sessionId: string,
    itemId: string,
  ): Promise<Result<{ item: QueuedInput; draft: TextDraft }>>;
  removeQueuedInput(sessionId: string, itemId: string): Promise<Result<void>>;
  sendQueuedNow(sessionId: string, itemId: string): Promise<Result<void>>;
  moveQueuedInput(sessionId: string, itemId: string, beforeId: string | null): Promise<Result<void>>;
  resumeInputQueue(sessionId: string): Promise<Result<void>>;
  abortRun(input: { sessionId: string; runId: string }): Promise<Result<void>>;
  getSettings(): Promise<Result<PublicSettings>>;
  beginChatGPTLogin(providerId: string | null): Promise<Result<{ loginId: string; url: string }>>;
  completeChatGPTLogin(
    loginId: string,
  ): Promise<Result<{ settings: PublicSettings; providerId: string; warning?: string }>>;
  submitChatGPTCallback(loginId: string, url: string): Promise<Result<void>>;
  cancelChatGPTLogin(loginId: string): Promise<Result<void>>;
  disconnectChatGPT(providerId: string): Promise<Result<{ settings: PublicSettings; warning?: string }>>;
  onSettings(listener: (settings: PublicSettings) => void): () => void;
  discoverModels(input: {
    preset?: ProviderPresetId;
    providerId?: string;
    baseUrl?: string;
    apiKey?: string;
  }): Promise<Result<ModelDiscoveryResult>>;
  saveProvider(input: ProviderInput): Promise<Result<PublicSettings>>;
  reorderProviders(ids: string[]): Promise<Result<PublicSettings>>;
  deleteProvider(id: string): Promise<Result<PublicSettings>>;
  getProviderCredentials(id: string): Promise<Result<{ apiKey: string }>>;
  updatePreferences(input: Partial<InterfacePreferences>): Promise<Result<PublicSettings>>;
  setSessionSelection(sessionId: string, selection: CombinedSelection): Promise<Result<SessionSnapshot>>;
  listSessionSkills(sessionId: string): Promise<Result<SkillList>>;
  listCommands(): Promise<Result<{ name: string; description: string }[]>>;
  openExternal(url: string): Promise<Result<void>>;
  onEvent(listener: (event: DesktopEventEnvelope) => void): () => void;
}
export const methods = [
  "beginChatGPTLogin",
  "completeChatGPTLogin",
  "submitChatGPTCallback",
  "cancelChatGPTLogin",
  "disconnectChatGPT",
  "archiveSession",
  "listArchivedSessions",
  "restoreSession",
  "openSessionDirectory",
  "createTerminal",
  "terminalInput",
  "resizeTerminal",
  "closeTerminal",
  "createBrowser",
  "browserAction",
  "browserBounds",
  "closeBrowser",
  "getDraft",
  "saveDraft",
  "getHistoryPage",
  "copyText",
  "searchFiles",
  "getWorkspaceInfo",
  "readFilePreview",
  "downloadImage",
  "importImage",
  "pickImages",
  "readAttachment",
  "removeAttachment",
  "getChanges",
  "readPatch",
  "previewPrompt",
  "listTools",
  "getSkillSettings",
  "readSkill",
  "setSkillEnabled",
  "listProjects",
  "addProject",
  "removeProject",
  "listSessions",
  "listRecentSessions",
  "setSessionPinned",
  "createSession",
  "activateSession",
  "getSessionSnapshot",
  "renameSession",
  "deleteSession",
  "startRun",
  "submitInput",
  "editQueuedInput",
  "removeQueuedInput",
  "sendQueuedNow",
  "moveQueuedInput",
  "resumeInputQueue",
  "abortRun",
  "getSettings",
  "discoverModels",
  "saveProvider",
  "reorderProviders",
  "deleteProvider",
  "getProviderCredentials",
  "updatePreferences",
  "setSessionSelection",
  "listSessionSkills",
  "listCommands",
  "openExternal",
] as const;
