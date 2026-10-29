// Adapted from ZCode workspace-file-tree; see licenses/third-party-notices.txt.
import { useMemo } from "react";
import {
  addDeletedGitStatusRowsToWorkspaceFileTree,
  flattenWorkspaceFileTreeRows,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeNode,
} from "./model.ts";

export function useWorkspaceFileTreeRows({
  workspacePath,
  childrenByDirectory,
  expandedPaths,
  loadedDirectoryPaths,
  loadingDirectoryPaths,
  errorByDirectory,
  gitStatusByPath,
}: {
  workspacePath: string;
  childrenByDirectory: Map<string, WorkspaceFileTreeNode[]>;
  expandedPaths: Set<string>;
  loadedDirectoryPaths: Set<string>;
  loadingDirectoryPaths: Set<string>;
  errorByDirectory: Map<string, Error>;
  gitStatusByPath: Map<string, WorkspaceFileGitStatus>;
}) {
  return useMemo(() => {
    const childrenWithGitOnlyRows = addDeletedGitStatusRowsToWorkspaceFileTree({
      rootPath: workspacePath,
      childrenByDirectory,
      statusByPath: gitStatusByPath,
    });

    return flattenWorkspaceFileTreeRows({
      rootPath: workspacePath,
      childrenByDirectory: childrenWithGitOnlyRows,
      expandedPaths,
      loadedDirectoryPaths,
      loadingDirectoryPaths,
      errorByDirectory,
    });
  }, [
    childrenByDirectory,
    errorByDirectory,
    expandedPaths,
    gitStatusByPath,
    loadedDirectoryPaths,
    loadingDirectoryPaths,
    workspacePath,
  ]);
}
