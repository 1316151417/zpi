import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";
import type { ProjectRecord } from "../shared/bridge.ts";
import type { SessionHost } from "./session-host.ts";

export async function openProjectFromDialog(
  sessionId: string | null,
  host: Pick<SessionHost, "workspaceInfo" | "listProjects" | "addProject">,
  showDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
  home = homedir(),
): Promise<ProjectRecord | null> {
  let defaultPath = home;
  if (sessionId !== null) {
    try {
      const { cwd, projectId } = host.workspaceInfo(sessionId);
      const path = host.listProjects(true).find((project) => project.id === projectId)?.path ?? cwd;
      if (isAbsolute(path) && (await stat(path)).isDirectory()) defaultPath = path;
    } catch {
      // A stale session or unavailable directory must not prevent opening another workspace.
    }
  }
  const selected = await showDialog({ properties: ["openDirectory"], defaultPath });
  const path = selected.canceled ? undefined : selected.filePaths[0];
  return path ? host.addProject(path) : null;
}
