import type { PaneTab } from "./pane-store.ts";
import { SessionConversation } from "./SessionConversation.tsx";
import { useStore } from "./store.ts";
import { UserQuestionCard } from "./UserQuestionCard.tsx";

export function SubagentPane({ tab }: { tab: Extract<PaneTab, { type: "subagent" }> }) {
  const view = useStore((state) => state.views.get(tab.childSessionId));
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
      <SessionConversation view={view} />
      {view.question && (
        <UserQuestionCard key={view.question.id} sessionId={tab.childSessionId} request={view.question} />
      )}
    </section>
  );
}
