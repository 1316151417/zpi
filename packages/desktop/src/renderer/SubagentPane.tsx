import { Conversation } from "zpi-ui";
import { inputContext } from "./composer-context.ts";
import { openChanges, openFile, openWebLink, type PaneTab, paneTask } from "./pane-store.ts";
import { previewServices } from "./preview-services.ts";
import { loadEarlier, unwrap, useStore } from "./store.ts";
import { UserQuestionCard } from "./UserQuestionCard.tsx";
import { useWorkspace } from "./use-workspace.ts";

export function SubagentPane({ tab }: { tab: Extract<PaneTab, { type: "subagent" }> }) {
  const view = useStore((state) => state.views.get(tab.childSessionId));
  const cursor = useStore((state) => state.historyCursors.get(tab.childSessionId));
  const loading = useStore((state) => state.historyLoading.has(tab.childSessionId));
  const workspace = useWorkspace(tab.childSessionId);
  if (!view)
    return (
      <div className="side-chat-loading" role="status">
        正在同步子智能体…
      </div>
    );
  return (
    <section
      className="side-chat-pane subagent-pane"
      aria-label="子智能体详情"
      data-subagent-session={tab.childSessionId}
    >
      <h2 className="sr-only">{tab.title}</h2>
      <Conversation
        view={view}
        workspace={workspace}
        context={inputContext}
        previewServices={previewServices}
        onLink={(url, options) => paneTask(openWebLink(url, options, tab.childSessionId))}
        onFile={(path, location, origin) => paneTask(openFile(tab.childSessionId, path, location, origin))}
        onCopy={(text) => window.zpi.copyText(text).then(unwrap)}
        onChanges={(runId, path, toolCallId) => openChanges(tab.childSessionId, runId, path, toolCallId)}
        onLoadToolPatch={(runId, toolCallId) =>
          window.zpi.readPatch(tab.childSessionId, runId, `operation:${toolCallId}`).then(unwrap)
        }
        onFileAction={(path, action, location) =>
          window.zpi.fileAction(tab.childSessionId, path, action, location).then(unwrap)
        }
        hasEarlier={cursor != null}
        loadingEarlier={loading}
        historyCursor={cursor}
        onLoadEarlier={() => loadEarlier(tab.childSessionId)}
      />
      {view.question && <UserQuestionCard sessionId={tab.childSessionId} request={view.question} />}
    </section>
  );
}
