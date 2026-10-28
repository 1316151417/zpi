export interface WorkspaceFileCandidate {
  path: string;
  name: string;
  absolutePath: string;
  type: "file" | "directory";
}
export interface WorkspaceFileSearchInput {
  query: string;
  requestId: string;
  rootPath?: string;
  filesOnly?: boolean;
  limit?: number;
  continuation?: string;
}
export interface WorkspaceFileSearchResult {
  entries: WorkspaceFileCandidate[];
  /** More matching entries exist than the bounded result list can display. */
  truncated: boolean;
  /** Some paths could not be scanned. Never present this as an exhaustive result. */
  incomplete: boolean;
  continuation?: string;
}

export interface WorkspaceDirectoryEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  isSymbolicLink?: boolean;
}
export type WorkspaceGitStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "ignored";
export interface WorkspaceGitChange {
  path: string;
  kind: Exclude<WorkspaceGitStatus, "ignored">;
  section: "staged" | "unstaged" | "untracked";
  isUntracked?: boolean;
  isConflicted?: boolean;
}
export interface WorkspaceGitSnapshot {
  summary: { isGitAvailable: boolean; isRepository: boolean };
  stagedChanges: WorkspaceGitChange[];
  unstagedChanges: WorkspaceGitChange[];
}
