import { type ReactNode, useState } from "react";
import type { SessionRecord } from "../shared/bridge.ts";
import { groupTimelineTasks, type TaskSortBy, taskPage } from "./sidebar-task-model.ts";

export function SidebarTaskEmpty({
  project = false,
  timeline = false,
}: {
  project?: boolean;
  timeline?: boolean;
}) {
  return (
    <div className={`task-list-empty${project ? " task-list-empty-project" : ""}`}>
      {project || timeline ? "暂无任务" : "还没有任务"}
    </div>
  );
}

export function SidebarTaskList({
  tasks,
  sortBy,
  timeline = false,
  renderRow,
}: {
  tasks: SessionRecord[];
  sortBy: TaskSortBy;
  timeline?: boolean;
  renderRow(record: SessionRecord, variant?: "default" | "timeline"): ReactNode;
}) {
  const [limit, setLimit] = useState(20);
  const page = taskPage(tasks, limit);
  if (!tasks.length) return <SidebarTaskEmpty timeline={timeline} />;
  return (
    <div className={timeline ? "timeline-tasks" : "recent-sessions"} data-task-limit={limit}>
      {timeline ? (
        groupTimelineTasks(page.items, sortBy).map((group) => (
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
          <button onClick={() => setLimit((current) => current + 20)}>显示更多</button>
        </div>
      )}
    </div>
  );
}
