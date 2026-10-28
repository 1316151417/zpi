import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceFileSearchResult } from "../shared/workspace-files.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";

export function useWorkspaceFileSearch({
  sessionId,
  query,
  rootPath,
  enabled = true,
  filesOnly = false,
  limit = 1000,
  revision = 0,
}: {
  sessionId: string | null;
  query: string;
  rootPath?: string;
  enabled?: boolean;
  filesOnly?: boolean;
  limit?: number;
  revision?: number;
}) {
  const key = JSON.stringify([sessionId, query, rootPath, enabled, filesOnly, limit, revision]);
  const [state, setState] = useState<{
    key: string;
    result?: WorkspaceFileSearchResult;
    error?: string;
    loading: boolean;
  }>();
  const more = useRef<() => void>(() => {});
  useEffect(() => {
    more.current = () => {};
    if (!enabled || !query.trim()) return;
    const requestId = crypto.randomUUID();
    let active = true;
    let started = false;
    let busy = false;
    let result: WorkspaceFileSearchResult | undefined;
    setState({ key, loading: true });
    const load = async () => {
      if (!active || busy) return;
      busy = true;
      started = true;
      setState({ key, result, loading: true });
      try {
        const next = unwrap(
          await window.zpi.searchWorkspaceFiles(sessionId, {
            query,
            rootPath,
            filesOnly,
            limit,
            requestId,
            continuation: result?.continuation,
          }),
        );
        if (active) {
          result = next;
          setState({ key, result, loading: false });
        }
      } catch (error) {
        if (active) setState({ key, result, loading: false, error: userErrorMessage(error) });
        // A failed/expired cursor must retry a fresh scan, not replay an invalid continuation.
        result = undefined;
      } finally {
        busy = false;
      }
    };
    more.current = () => void load();
    const timer = setTimeout(() => void load(), 150);
    return () => {
      active = false;
      clearTimeout(timer);
      more.current = () => {};
      if (started)
        void window.zpi
          .cancelWorkspaceFileSearch(requestId)
          .then(unwrap)
          .catch(() => {});
    };
  }, [key, enabled, sessionId, query, rootPath, filesOnly, limit]);
  return {
    result: state?.key === key ? state.result : undefined,
    error: state?.key === key ? state.error : undefined,
    loading: Boolean(enabled && query.trim() && (state?.key !== key || state.loading)),
    loadMore: useCallback(() => more.current(), []),
  };
}
