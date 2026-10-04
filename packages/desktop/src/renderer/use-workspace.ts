import { useEffect, useState } from "react";
import type { WorkspaceInfo } from "../shared/bridge.ts";
import { report, unwrap } from "./store.ts";

export function useWorkspace(sessionId: string | undefined) {
  const [workspace, setWorkspace] = useState<{ id: string; info: WorkspaceInfo }>();
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    void window.zpi
      .getWorkspaceInfo(sessionId)
      .then((result) => {
        if (active) setWorkspace({ id: sessionId, info: unwrap(result) });
      })
      .catch((error) => {
        if (active) report(error);
      });
    return () => {
      active = false;
    };
  }, [sessionId]);
  return workspace && workspace.id === sessionId ? workspace.info : undefined;
}
