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
}
export interface WorkspaceGitSnapshot {
  summary: { isGitAvailable: boolean; isRepository: boolean };
  stagedChanges: WorkspaceGitChange[];
  unstagedChanges: WorkspaceGitChange[];
}
