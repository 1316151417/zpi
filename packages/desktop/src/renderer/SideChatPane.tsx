import { useEffect, useState } from "react";
import { ChatComposer, Conversation } from "zpi-ui";
import { inputContext } from "./composer-context.ts";
import { composerShortcutCommand } from "./composer-shortcuts.ts";
import { ModelPerformance } from "./ModelPerformance.tsx";
import { loadSideChat, openChanges, openFile, openWebLink, paneTask } from "./pane-store.ts";
import { previewServices } from "./preview-services.ts";
import { SessionToolbar } from "./SessionToolbar.tsx";
import {
  addConversationSelection,
  drafts,
  loadEarlier,
  queueActions,
  report,
  unwrap,
  useStore,
} from "./store.ts";
import { UserQuestionCard } from "./UserQuestionCard.tsx";
import { useWorkspace } from "./use-workspace.ts";

export function SideChatPane({
  sessionId,
  visible,
  onSettings,
}: {
  sessionId: string;
  visible: boolean;
  onSettings: () => void;
}) {
  const view = useStore((state) => state.views.get(sessionId));
  const record = useStore((state) => state.sessions.get(sessionId));
  const settings = useStore((state) => state.settings);
  const suggestions = useStore((state) => state.suggestions.get(sessionId));
  const cursor = useStore((state) => state.historyCursors.get(sessionId));
  const loadingEarlier = useStore((state) => state.historyLoading.has(sessionId));
  const workspace = useWorkspace(sessionId);
  const [modelOpen, setModelOpen] = useState(false);
  useEffect(() => {
    if (!useStore.getState().views.has(sessionId)) paneTask(loadSideChat(sessionId));
  }, [sessionId]);
  const running = view?.runs.find((run) => run.status === "running");
  const stop = () => {
    if (running) paneTask(window.zpi.abortRun({ sessionId, runId: running.runId }).then(unwrap));
  };
  if (!view)
    return (
      <div className="side-chat-loading" role="status">
        正在加载辅助对话…
      </div>
    );
  return (
    <section className="side-chat-pane" aria-label="辅助对话" data-side-chat-session={sessionId}>
      <Conversation
        view={view}
        workspace={workspace}
        context={inputContext}
        previewServices={previewServices}
        onLink={(url, options) => paneTask(openWebLink(url, options, sessionId))}
        onFile={(path, location) => openFile(sessionId, path, location)}
        onCopy={(text) => window.zpi.copyText(text).then(unwrap)}
        onAddSelection={
          view.question ? undefined : (reference) => addConversationSelection(reference, sessionId)
        }
        addSelectionLabel="添加到当前辅助对话"
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
      <div className="composer-container">
        {view.question && (
          <UserQuestionCard
            key={view.question.id}
            sessionId={sessionId}
            request={view.question}
            visible={visible}
          />
        )}
        {!view.question && (
          <ChatComposer
            sessionId={sessionId}
            historyScope={record?.cwd}
            draftStorage={drafts}
            context={inputContext}
            busy={Boolean(running)}
            showSendButton={settings?.interface.showSendButton ?? false}
            suggestions={suggestions ?? []}
            sentMessages={view.runs.map((run) => run.userMessage)}
            queue={view.queue}
            queueActions={queueActions(sessionId)}
            shortcutCommand={(event) =>
              composerShortcutCommand(event, window.zpi.platform, settings?.shortcuts)
            }
            onSelectModel={() => setModelOpen(true)}
            onFile={(path, location) => openFile(sessionId, path, location)}
            toolbar={
              <SessionToolbar
                view={view}
                open={modelOpen}
                onOpenChange={setModelOpen}
                onSettings={onSettings}
              />
            }
            onStop={stop}
            onSubmit={async (text, input) => {
              try {
                const result = unwrap(await window.zpi.submitInput({ sessionId, text, ...input }));
                if (result.confirmationRequired) return "confirmationRequired";
              } catch (error) {
                if (!view.controls?.selectionValid) setModelOpen(true);
                report(error);
                throw error;
              }
            }}
          />
        )}
        {!view.question && settings?.interface.showModelPerformance && (
          <ModelPerformance value={view.modelPerformance} />
        )}
      </div>
    </section>
  );
}
