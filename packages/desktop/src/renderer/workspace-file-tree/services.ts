import { useMemo } from "react";
import { unwrap } from "../unwrap.ts";
import { buildWorkspaceFileGitStatusByPath, isWorkspaceFileTreeGitStatusAvailable } from "./model.ts";

export function useWorkspaceServices(sessionId: string, rootPath: string) {
  return useMemo(
    () => ({
      fileService: {
        readdir: ({ path }: { path: string }) =>
          window.zpi.readWorkspaceDirectory(sessionId, path, rootPath).then(unwrap),
      },
      gitService: {
        refresh: () => window.zpi.workspaceGitStatus(sessionId, rootPath).then(unwrap),
        getIgnoredPaths: ({ paths }: { paths: string[] }) =>
          window.zpi.ignoredWorkspacePaths(sessionId, paths, rootPath).then(unwrap),
      },
      fileWatcherService: {
        watch: ({ path }: { path: string }) =>
          window.zpi.watchWorkspaceDirectory(sessionId, path, rootPath).then(unwrap),
        unwatch: ({ id }: { id: string }) => window.zpi.unwatchWorkspaceDirectory(id).then(unwrap),
        onDynamicChange: (id: string) => (listener: (event: { dirPath: string }) => void) => ({
          dispose: window.zpi.onWorkspaceDirectoryChange(id, listener),
        }),
      },
    }),
    [sessionId, rootPath],
  );
}
export type IFileWatcherService = ReturnType<typeof useWorkspaceServices>["fileWatcherService"];
export async function loadWorkspaceFileTreeGitStatus({
  gitService,
}: {
  gitService: ReturnType<typeof useWorkspaceServices>["gitService"];
}) {
  const snapshot = await gitService.refresh();
  const available = isWorkspaceFileTreeGitStatusAvailable(snapshot.summary);
  return {
    available,
    statusByPath: available
      ? buildWorkspaceFileGitStatusByPath([...snapshot.unstagedChanges, ...snapshot.stagedChanges])
      : new Map(),
  };
}
