import { type ReactNode, useState } from "react";
import type { SessionRecord } from "../shared/bridge.ts";
import { groupTimelineTasks, taskPage } from "./sidebar-task-model.ts";

export function SidebarTaskEmpty({ timeline = false }: { timeline?: boolean }) {
  return <div className={`task-list-empty${timeline ? " task-list-empty-timeline" : ""}`}>暂无任务</div>;
}

export function SidebarTaskList({
  tasks,
  timeline = false,
  renderRow,
}: {
  tasks: SessionRecord[];
  timeline?: boolean;
  renderRow(record: SessionRecord, variant?: "default" | "timeline"): ReactNode;
}) {
  const pageSize = timeline ? 20 : 5;
  const [limit, setLimit] = useState(pageSize);
  const page = taskPage(tasks, limit);
  if (!tasks.length) return <SidebarTaskEmpty timeline={timeline} />;
  return (
    <div className={timeline ? "timeline-tasks" : "recent-sessions"} data-task-limit={limit}>
      {timeline ? (
        groupTimelineTasks(page.items).map((group) => (
          <section className="timeline-group" key={group.key} aria-label={group.label}>
            <div className="timeline-group-label">{group.label}</div>
            <div className="task-list-rows">{group.items.map((record) => renderRow(record, "timeline"))}</div>
          </section>
        ))
      ) : (
        <div className="task-list-rows">{page.items.map((record) => renderRow(record))}</div>
      )}
      {page.hasMore && (
        <div className="task-show-more task-show-more-global">
          <button onClick={() => setLimit((current) => current + pageSize)}>显示更多</button>
        </div>
      )}
    </div>
  );
}
