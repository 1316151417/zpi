import type { Model, ModelCompat, ModelDiscoveryResult, ProviderApi, ProviderPresetId } from "zpi-ai";
import type { Attachment, DiscoveredSkill, SkillList } from "zpi-coding-agent";
import type {
  DesktopEventEnvelope,
  FileAction,
  QueuedInput,
  RunStatus,
  SessionControls,
  SessionMentionSuggestion,
  SessionView,
  WorktreeInfo,
} from "zpi-ui";
import type { FileLocation } from "zpi-ui/links";
import type { CommandImportDiscovery, CommandImportRequest, CommandImportResult } from "./command-import.ts";
import type {
  CustomCommand,
  CustomCommandDelete,
  CustomCommandInput,
  CustomCommandSetEnabled,
  CustomCommandsList,
  CustomCommandUpdate,
} from "./custom-commands.ts";
import type { EditorInfo } from "./editors.ts";
import type { MemorySettings, MemoryStatus } from "./memory.ts";
import type { ShortcutCommand, ShortcutSettings } from "./shortcuts.ts";
import type { SaveSubagentInput, SubagentCatalog } from "./subagents.ts";

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
export interface TaskSearchChange {
  path: string;
  added: number;
  removed: number;
  lastTurnIndex: number;
  writeCount: number;
}
export interface TaskSearchResult extends SessionRecord {
  snippets: import("./task-search.ts").TaskSearchSnippet[];
}
export interface SessionRecord {
  parentSessionId?: string;
  newWorktree?: boolean;
  worktreeBaseRef?: string;
  worktree?: WorktreeInfo;
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
  /** Runtime evidence supplied by SessionHost, never restored from persisted status. */
  running?: boolean;
  pendingQuestion?: Pick<import("zpi-ui").UserQuestionRequest, "id" | "autoResolution"> | null;
  activitySeq?: number;
  createdAt: number;
  updatedAt: number;
}
export interface GitEnvironment {
  branch: string;
  head: string;
  currentRef: string | null;
  branches: { ref: string; name: string; remote: boolean }[];
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
  compat?: ModelCompat;
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
  compat?: ModelCompat;
  thinkingLevelMap?: Model["thinkingLevelMap"];
  reasoningConfig?: Model["reasoningConfig"];
  defaultThinkingLevel?: Model["defaultThinkingLevel"];
  availability?: "listed" | "unverified";
  samplingParams?: Model["samplingParams"];
}
export interface ProviderInput {
  api?: ProviderApi;
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
  codePreview?: import("zpi-ui/code-preview").CodePreviewSettings;
  theme: "system" | "light" | "dark";
  fontSize: number;
  showContextUsage: boolean;
  showModelPerformance: boolean;
  showSendButton: boolean;
  notificationEnabled: boolean;
  notificationSoundEnabled: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  collapsedProjectIds: string[];
  projectsCollapsed: boolean;
  tasksCollapsed: boolean;
}
export interface SessionCapabilities {
  webSearch: boolean;
  communicationStyle: boolean;
  subagents: boolean;
  askUserQuestion: boolean;
  toolBatching: boolean;
  fileLinks: boolean;
  fileContextReuse: boolean;
  proactiveExecution: boolean;
}
export type CapabilityName = keyof SessionCapabilities;
export interface WebSearchSettingsInput {
  provider: "deepseek";
  enabled?: boolean;
  /** Omit to retain the saved key; an empty string removes it. */
  apiKey?: string;
}
export interface QuickChatSettingsInput {
  defaultSelection: CombinedSelection | null;
}
export interface PublicSettings {
  quickChat: QuickChatSettingsInput;
  webSearch: {
    provider: "deepseek";
    enabled: boolean;
    hasApiKey: boolean;
    apiKeyLength: number;
    credentialsPersisted: boolean;
    credentialsLocked: boolean;
  };
  shortcuts: ShortcutSettings;
  capabilities: SessionCapabilities;
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
  /** Internal plugin delivery; renderer IPC does not accept this field. */
  subagentNotification?: import("zpi-ui").SubagentNotification;
  sessionId: string;
  text: string;
  fileReferences?: string[];
  attachments?: string[];
}
export type EditUserInput = Omit<RunInput, "sessionId"> & { workspaceMode?: "preserve" | "rewind" };
export type EditUserResult = SessionSnapshot | { conflicts: import("zpi-ui").FileRewindConflict[] };
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
  customInstructions: string;
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
  snapshotUnavailable?: boolean;
  failed?: boolean;
  added?: number;
  removed?: number;
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
  selections?: import("zpi-ui").ConversationSelection[];
  text: string;
  fileReferences: string[];
  selection: [number, number];
  revision: number;
}
export type FilePreview = { location?: FileLocation } & (
  | { path: string; kind: "text"; text: string; truncated: boolean }
  | {
      path: string;
      kind: "image" | "media" | "xlsx" | "docx" | "doc" | "pdf" | "pptx";
      bytes: Uint8Array;
      totalBytes?: number;
      mime?: string;
    }
  | { path: string; kind: "unsupported" }
  | { path: string; kind: "directory" }
);
export interface TerminalProfileTheme {
  selectionBackground?: string;
  selectionInactiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}
export interface TerminalProfile {
  fontFamily?: string;
  fontSize?: number;
  theme?: TerminalProfileTheme;
}
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
  openQuickChat(): Promise<Result<void>>;
  setSessionUnread(id: string): Promise<Result<void>>;
  getTaskGroups(): Promise<Result<import("./task-groups.ts").TaskGroupState>>;
  updateTaskGroups(
    command: Exclude<import("./task-groups.ts").TaskGroupCommand, { type: "create" }> | { type: "create" },
  ): Promise<Result<import("./task-groups.ts").TaskGroupState>>;
  listSubagents(sessionId: string | null): Promise<Result<SubagentCatalog>>;
  saveSubagent(input: SaveSubagentInput): Promise<Result<SubagentCatalog>>;
  deleteSubagent(id: string, sessionId: string | null): Promise<Result<SubagentCatalog>>;
  setSubagentEnabled(
    id: string,
    enabled: boolean,
    sessionId: string | null,
  ): Promise<Result<SubagentCatalog>>;
  stopSubagent(parentSessionId: string, agentId: string): Promise<Result<void>>;
  stopBackgroundTask(sessionId: string, taskId: string): Promise<Result<void>>;
  readBackgroundTask(
    sessionId: string,
    taskId: string,
  ): Promise<Result<import("zpi-ui").BackgroundTaskOutput>>;
  setCapabilityEnabled(name: CapabilityName, enabled: boolean): Promise<Result<PublicSettings>>;
  snoozeQuestion(sessionId: string, requestId: string): Promise<Result<void>>;
  respondToQuestion(
    sessionId: string,
    requestId: string,
    response: import("zpi-ui").UserQuestionResponse,
  ): Promise<Result<void>>;
  closeSideChat(sessionId: string): Promise<Result<void>>;
  createSideChat(sessionId: string): Promise<Result<SessionRecord>>;
  getGitEnvironment(sessionId: string): Promise<Result<GitEnvironment | null>>;
  setNewWorktree(sessionId: string, enabled: boolean, baseRef?: string): Promise<Result<SessionRecord>>;
  logError(error: { source: string; message: string; stack?: string }): void;
  readonly platform: string;
  readonly workspacePanelRadius: number;
  onBeforeQuit(listener: () => Promise<void>): () => void;
  onTaskNotificationClick(listener: (sessionId: string) => void): () => void;
  onTaskNotificationSound(listener: () => void): () => void;
  archiveSession(id: string): Promise<Result<void>>;
  listArchivedSessions(): Promise<Result<(SessionRecord & { projectName: string })[]>>;
  restoreSession(id: string): Promise<Result<SessionRecord>>;
  openDirectory(path: string): Promise<Result<void>>;
  createTerminal(
    sessionId: string,
  ): Promise<Result<{ id: string; shell: string; profile?: TerminalProfile }>>;
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
  copySessionPath(sessionId: string): Promise<Result<void>>;
  printPageToPdf(sessionId: string): Promise<Result<Uint8Array>>;
  savePreviewPdf(
    data: Uint8Array,
    suggestedName: string,
  ): Promise<Result<{ canceled: boolean; path?: string }>>;
  getInstalledEditors(): Promise<Result<EditorInfo[]>>;
  getMemorySettings(): Promise<Result<MemorySettings>>;
  saveMemorySettings(input: MemorySettings): Promise<Result<MemorySettings>>;
  getMemoryStatus(sessionId: string | null): Promise<Result<MemoryStatus>>;
  checkMemoryNow(sessionId: string | null): Promise<Result<MemoryStatus>>;
  clearLongMemory(): Promise<Result<MemoryStatus>>;
  openMemoryFile(
    sessionId: string | null,
    scope: "user" | "project" | "long",
    action: "view" | "edit",
  ): Promise<Result<{ path: string; content: string; exists: boolean }>>;
  openInEditor(sessionId: string, path: string, editorId: string): Promise<Result<void>>;
  fileAction(
    sessionId: string,
    path: string,
    action: FileAction,
    location?: FileLocation,
  ): Promise<Result<void>>;
  searchFiles(
    sessionId: string,
    query: string,
  ): Promise<Result<{ path: string; name: string; absolutePath: string; type: "file" | "directory" }[]>>;
  getWorkspaceInfo(sessionId: string | null): Promise<Result<WorkspaceInfo>>;
  readWebSourceIcon(
    sessionId: string,
    runId: string,
    sourceUrl: string,
  ): Promise<Result<{ dataUrl?: string }>>;
  downloadImage(src: string): Promise<Result<void>>;
  checkPreviewFiles(
    sessionId: string,
    paths: string[],
  ): Promise<Result<Array<{ path: string; exists: boolean }>>>;
  readPreviewRange(
    sessionId: string,
    path: string,
    offset: number,
    length: number,
  ): Promise<Result<Uint8Array>>;
  readFilePreview(sessionId: string, path: string, location?: FileLocation): Promise<Result<FilePreview>>;
  readWorkspaceDirectory(
    sessionId: string,
    path: string,
    rootPath?: string,
  ): Promise<Result<import("./workspace-files.ts").WorkspaceDirectoryEntry[]>>;
  workspaceGitStatus(
    sessionId: string,
    rootPath?: string,
  ): Promise<Result<import("./workspace-files.ts").WorkspaceGitSnapshot>>;
  ignoredWorkspacePaths(sessionId: string, paths: string[], rootPath?: string): Promise<Result<string[]>>;
  watchWorkspaceDirectory(
    sessionId: string,
    path: string,
    rootPath?: string,
    recursive?: boolean,
  ): Promise<Result<{ id: string }>>;
  watchReviewDirectory(sessionId: string, path: string): Promise<Result<{ id: string }>>;
  unwatchWorkspaceDirectory(id: string): Promise<Result<void>>;
  onWorkspaceDirectoryChange(id: string, listener: (event: { dirPath: string }) => void): () => void;

  pickAttachments(sessionId: string): Promise<Result<Attachment[]>>;
  importAttachment(sessionId: string, file: File): Promise<Result<Attachment>>;
  readAttachment(sessionId: string, id: string): Promise<Result<{ metadata: Attachment; data: string }>>;
  removeAttachment(sessionId: string, id: string): Promise<Result<void>>;
  getChanges(
    sessionId: string,
    runId: string | null,
    includePatch?: boolean,
    includeStats?: boolean,
  ): Promise<Result<DiffItem[]>>;
  readPatch(sessionId: string, runId: string | null, id: string): Promise<Result<string>>;
  getReview(
    sessionId: string,
    source: import("./review.ts").ReviewSource,
  ): Promise<Result<import("./review.ts").ReviewSnapshot>>;
  readReviewDiff(
    sessionId: string,
    source: import("./review.ts").ReviewSource,
    path: string,
    runId?: string,
  ): Promise<Result<import("./review.ts").ReviewDiffData>>;
  previewPrompt(): Promise<Result<PromptPreview>>;
  listTools(): Promise<Result<ToolInfo[]>>;
  getSkillSettings(): Promise<Result<SkillSettings>>;
  readSkill(path: string): Promise<Result<string>>;
  setSkillEnabled(path: string, enabled: boolean): Promise<Result<PublicSettings>>;
  listProjects(): Promise<Result<ProjectRecord[]>>;
  addProject(sessionId: string | null): Promise<Result<ProjectRecord | null>>;
  removeProject(id: string): Promise<Result<void>>;
  reorderProjects(ids: string[]): Promise<Result<void>>;
  listSessions(projectId: string): Promise<Result<SessionRecord[]>>;
  getTaskSearchChanges(sessionId: string): Promise<Result<TaskSearchChange[]>>;
  searchTasks(query: string, workspaceKey: string | null): Promise<Result<TaskSearchResult[]>>;
  listTaskFiles(
    sessionId: string | null,
    rootPath?: string,
  ): Promise<Result<{ path: string; name: string; absolutePath: string; type: "file" | "directory" }[]>>;
  listRecentSessions(): Promise<Result<SessionRecord[]>>;
  listSessionMentions(sessionId: string): Promise<Result<SessionMentionSuggestion[]>>;
  createSession(projectId: string | null, groupId?: string | null): Promise<Result<SessionRecord>>;
  activateSession(sessionId: string): Promise<Result<SessionRecord>>;
  setSessionPinned(sessionId: string, pinned: boolean): Promise<Result<SessionRecord>>;
  getSessionSnapshot(sessionId: string): Promise<Result<SessionSnapshot>>;
  renameSession(id: string, name: string): Promise<Result<SessionRecord>>;
  deleteSession(id: string): Promise<Result<void>>;
  startRun(input: RunInput): Promise<Result<{ runId: string }>>;
  submitInput(
    input: RunInput & { queueDisposition?: "keep" | "clear"; immediate?: boolean },
  ): Promise<Result<{ runId?: string; queueItemId?: string; confirmationRequired?: true }>>;
  editQueuedInput(
    sessionId: string,
    itemId: string,
  ): Promise<Result<{ item: QueuedInput; draft: TextDraft }>>;
  removeQueuedInput(sessionId: string, itemId: string): Promise<Result<void>>;
  sendQueuedNow(sessionId: string, itemId: string): Promise<Result<void>>;
  moveQueuedInput(sessionId: string, itemId: string, beforeId: string | null): Promise<Result<void>>;
  resumeInputQueue(sessionId: string): Promise<Result<void>>;
  forkSession(id: string, runId: string): Promise<Result<SessionRecord>>;
  editUserMessage(id: string, runId: string, input: EditUserInput): Promise<Result<EditUserResult>>;
  abortRun(input: { sessionId: string; runId: string }): Promise<Result<void>>;
  getSettings(): Promise<Result<PublicSettings>>;
  updateShortcuts(input: ShortcutSettings): Promise<Result<PublicSettings>>;
  setShortcutCapture(capturing: boolean): Promise<Result<void>>;
  onShortcutModifier(listener: (held: boolean) => void): () => void;
  onShortcut(listener: (command: ShortcutCommand) => void): () => void;
  beginChatGPTLogin(providerId: string | null): Promise<Result<{ loginId: string; url: string }>>;
  completeChatGPTLogin(
    loginId: string,
  ): Promise<Result<{ settings: PublicSettings; providerId: string; warning?: string }>>;
  submitChatGPTCallback(loginId: string, url: string): Promise<Result<void>>;
  cancelChatGPTLogin(loginId: string): Promise<Result<void>>;
  disconnectChatGPT(providerId: string): Promise<Result<{ settings: PublicSettings; warning?: string }>>;
  onSettings(listener: (settings: PublicSettings) => void): () => void;
  discoverModels(input: {
    api?: ProviderApi;
    preset?: ProviderPresetId;
    providerId?: string;
    baseUrl?: string;
    apiKey?: string;
  }): Promise<Result<ModelDiscoveryResult>>;
  saveProvider(input: ProviderInput): Promise<Result<PublicSettings>>;
  saveWebSearch(input: WebSearchSettingsInput): Promise<Result<PublicSettings>>;
  saveQuickChatSettings(input: QuickChatSettingsInput): Promise<Result<PublicSettings>>;
  reorderProviders(ids: string[]): Promise<Result<PublicSettings>>;
  deleteProvider(id: string): Promise<Result<PublicSettings>>;
  getProviderCredentials(id: string): Promise<Result<{ apiKey: string }>>;
  /** Read only when the user explicitly reveals the key in web search settings. */
  getWebSearchCredentials(): Promise<Result<{ apiKey: string }>>;
  updatePreferences(input: Partial<InterfacePreferences>): Promise<Result<PublicSettings>>;
  setSessionSelection(sessionId: string, selection: CombinedSelection): Promise<Result<SessionSnapshot>>;
  listSessionSkills(sessionId: string): Promise<Result<SkillList>>;
  listCommands(): Promise<Result<{ name: string; description: string }[]>>;
  listSessionCustomCommands(sessionId: string): Promise<Result<CustomCommandsList>>;
  getCustomCommands(projectId?: string): Promise<Result<CustomCommandsList>>;
  createCustomCommand(input: CustomCommandInput, projectId?: string): Promise<Result<CustomCommand>>;
  updateCustomCommand(input: CustomCommandUpdate, projectId?: string): Promise<Result<CustomCommand>>;
  deleteCustomCommand(input: CustomCommandDelete, projectId?: string): Promise<Result<void>>;
  setCustomCommandEnabled(input: CustomCommandSetEnabled, projectId?: string): Promise<Result<CustomCommand>>;
  discoverCommandImports(projectId?: string): Promise<Result<CommandImportDiscovery>>;
  importCommands(input: CommandImportRequest, projectId?: string): Promise<Result<CommandImportResult>>;
  openExternal(url: string): Promise<Result<void>>;
  onEvent(listener: (event: DesktopEventEnvelope) => void): () => void;
}
export const methods = [
  "getMemorySettings",
  "saveMemorySettings",
  "getMemoryStatus",
  "checkMemoryNow",
  "clearLongMemory",
  "openMemoryFile",
  "openQuickChat",
  "setSessionUnread",
  "getTaskGroups",
  "updateTaskGroups",
  "listSubagents",
  "saveSubagent",
  "deleteSubagent",
  "setSubagentEnabled",
  "stopSubagent",
  "stopBackgroundTask",
  "readBackgroundTask",
  "setCapabilityEnabled",
  "respondToQuestion",
  "snoozeQuestion",
  "createSideChat",
  "closeSideChat",
  "getGitEnvironment",
  "setNewWorktree",
  "beginChatGPTLogin",
  "completeChatGPTLogin",
  "submitChatGPTCallback",
  "cancelChatGPTLogin",
  "disconnectChatGPT",
  "archiveSession",
  "listArchivedSessions",
  "restoreSession",
  "openDirectory",
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
  "copySessionPath",
  "fileAction",
  "getInstalledEditors",
  "printPageToPdf",
  "savePreviewPdf",
  "openInEditor",
  "searchFiles",
  "getWorkspaceInfo",
  "readFilePreview",
  "readWorkspaceDirectory",
  "workspaceGitStatus",
  "ignoredWorkspacePaths",
  "watchWorkspaceDirectory",
  "watchReviewDirectory",
  "unwatchWorkspaceDirectory",
  "readPreviewRange",
  "checkPreviewFiles",
  "downloadImage",
  "readWebSourceIcon",
  "pickAttachments",
  "importAttachment",
  "readAttachment",
  "removeAttachment",
  "getChanges",
  "readPatch",
  "getReview",
  "readReviewDiff",
  "previewPrompt",
  "listTools",
  "getSkillSettings",
  "readSkill",
  "setSkillEnabled",
  "listProjects",
  "addProject",
  "removeProject",
  "reorderProjects",
  "listSessions",
  "getTaskSearchChanges",
  "searchTasks",
  "listTaskFiles",
  "listRecentSessions",
  "listSessionMentions",
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
  "forkSession",
  "editUserMessage",
  "abortRun",
  "getSettings",
  "updateShortcuts",
  "setShortcutCapture",
  "discoverModels",
  "saveProvider",
  "saveWebSearch",
  "saveQuickChatSettings",
  "reorderProviders",
  "deleteProvider",
  "getProviderCredentials",
  "getWebSearchCredentials",
  "updatePreferences",
  "setSessionSelection",
  "listSessionSkills",
  "listCommands",
  "getCustomCommands",
  "listSessionCustomCommands",
  "createCustomCommand",
  "updateCustomCommand",
  "deleteCustomCommand",
  "setCustomCommandEnabled",
  "discoverCommandImports",
  "importCommands",
  "openExternal",
] as const;
