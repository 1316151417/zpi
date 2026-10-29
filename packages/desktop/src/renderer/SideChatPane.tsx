import { useState } from "react";
import { ChatComposer } from "zpi-ui";
import { inputContext } from "./composer-context.ts";
import { composerShortcutCommand } from "./composer-shortcuts.ts";
import { ModelPerformance } from "./ModelPerformance.tsx";
import { openFile, paneTask } from "./pane-store.ts";
import { SessionConversation } from "./SessionConversation.tsx";
import { SessionToolbar } from "./SessionToolbar.tsx";
import { addConversationSelection, drafts, queueActions, report, useStore } from "./store.ts";
import { UserQuestionCard } from "./UserQuestionCard.tsx";
import { unwrap } from "./unwrap.ts";

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
  const [modelOpen, setModelOpen] = useState(false);
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
      <SessionConversation
        view={view}
        suggestions={suggestions ?? []}
        onAddSelection={
          view.question ? undefined : (reference) => addConversationSelection(reference, sessionId)
        }
        addSelectionLabel="添加到当前辅助对话"
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
            onFile={(path, location, origin) => paneTask(openFile(sessionId, path, location, origin))}
            toolbar={
              <SessionToolbar
                view={view}
                open={modelOpen}
                onOpenChange={setModelOpen}
                onSettings={onSettings}
              />
            }
            onStop={stop}
            onSubmit={async (text, input, { draftRevision }) => {
              try {
                const result = unwrap(await window.zpi.submitInput({ sessionId, text, ...input }));
                if (result.confirmationRequired) return "confirmationRequired";
              } catch (error) {
                if (!view.controls?.selectionValid) setModelOpen(true);
                report(error, { input: sessionId, revision: draftRevision });
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
