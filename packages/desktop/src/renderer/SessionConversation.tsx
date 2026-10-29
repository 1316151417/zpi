import type { ComponentProps } from "react";
import { Conversation } from "zpi-ui";
import { inputContext } from "./composer-context.ts";
import { openChanges, openFile, openWebLink, paneTask } from "./pane-store.ts";
import { previewServices } from "./preview-services.ts";
import { loadEarlier, useStore } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import { useWorkspace } from "./use-workspace.ts";

export function SessionConversation({
  view,
  ...props
}: Pick<
  ComponentProps<typeof Conversation>,
  "view" | "suggestions" | "onAddSelection" | "addSelectionLabel"
>) {
  const { sessionId } = view;
  const cursor = useStore((state) => state.historyCursors.get(sessionId));
  const loadingEarlier = useStore((state) => state.historyLoading.has(sessionId));
  const workspace = useWorkspace(sessionId);
  return (
    <Conversation
      {...props}
      view={view}
      workspace={workspace}
      context={inputContext}
      previewServices={previewServices}
      onRetryModel={(runId) => window.zpi.retryModelRequest({ sessionId, runId }).then(unwrap)}
      onLink={(url, options) => paneTask(openWebLink(url, options, sessionId))}
      onFile={(path, location, origin) => paneTask(openFile(sessionId, path, location, origin))}
      onCopy={(text) => window.zpi.copyText(text).then(unwrap)}
      onFileAction={(path, action, location) =>
        window.zpi.fileAction(sessionId, path, action, location).then(unwrap)
      }
      onChanges={(runId, path, toolCallId) => openChanges(sessionId, runId, path, toolCallId)}
      onLoadToolPatch={(runId, toolCallId) =>
        window.zpi.readPatch(sessionId, runId, `operation:${toolCallId}`).then(unwrap)
      }
      historyCursor={cursor}
      hasEarlier={cursor != null}
      loadingEarlier={loadingEarlier}
      onLoadEarlier={() => loadEarlier(sessionId)}
    />
  );
}
