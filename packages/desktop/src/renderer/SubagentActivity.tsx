// Running status and the paged directory follow ZCode ConversationStatusPanel/SubagentDirectorySidePane.
import {
  Ban,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  LoaderCircle,
  PauseCircle,
  Square,
} from "lucide-react";
import { useEffect, useState } from "react";
import { type SubagentTask, subagentStatusLabels } from "zpi-ui";
import { openSubagent, openSubagentDirectory, paneTask } from "./pane-store.ts";
import { formatTaskRelativeTime } from "./sidebar-task-model.ts";
import { unwrap, useStore } from "./store.ts";

const emptyTasks: SubagentTask[] = [];

function useNow(running: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
function duration(task: SubagentTask, now: number) {
  const seconds = Math.max(0, Math.floor(((task.endedAt ?? now) - task.startedAt) / 1000));
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}
export function SubagentActivity({ tasks }: { tasks: SubagentTask[] }) {
  const [open, setOpen] = useState(false);
  const running = tasks.filter((task) => task.status === "running").sort((a, b) => a.startedAt - b.startedAt);
  const ended = tasks.length - running.length;
  const now = useNow(running.length > 0);
  if (!tasks.length) return null;
  return (
    <div className="subagent-activity">
      <button className="subagent-activity-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Bot size={16} />
        <span>子智能体</span>
        <span>
          {!open && running[0] ? `${duration(running[0], now)} · ` : ""}
          {running.length}个运行中
        </span>
        <ChevronRight size={14} className={open ? "rotated" : ""} />
      </button>
      {open && (
        <div className="subagent-activity-list">
          {running.map((task) => (
            <div className="subagent-running-row" key={task.agentId}>
              <button
                aria-label={`查看子智能体 ${task.description}`}
                onClick={() => paneTask(openSubagent(task))}
              >
                <Bot size={16} />
                <span>
                  <strong>{task.description}</strong>
                  <small>
                    {task.waitingForInput ? "等待回答 · " : ""}
                    {duration(task, now)}
                  </small>
                </span>
              </button>
              <button
                aria-label={`停止子智能体 ${task.description}`}
                title="停止子智能体"
                onClick={() =>
                  paneTask(window.zpi.stopSubagent(task.parentSessionId, task.agentId).then(unwrap))
                }
              >
                <Square size={12} />
              </button>
            </div>
          ))}
          {ended > 0 && (
            <button
              className="subagent-ended"
              onClick={() => openSubagentDirectory(tasks[0].parentSessionId)}
            >
              <CheckCircle2 size={16} />
              <span>已结束</span>
              <span>{ended}</span>
              <ChevronRight size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
export function SubagentDirectory({ sessionId }: { sessionId: string }) {
  const tasks = useStore((state) => state.views.get(sessionId)?.subagents ?? emptyTasks);
  const [limit, setLimit] = useState(20);
  const now = useNow(tasks.some((task) => task.status === "running"));
  return (
    <section className="subagent-directory" aria-label="子智能体目录">
      <h2>子智能体目录</h2>
      <div>
        {([true, false] as const).map((running) => {
          const group = tasks
            .filter((task) => (task.status === "running") === running)
            .sort((a, b) =>
              running ? a.startedAt - b.startedAt : (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt),
            );
          if (!group.length) return null;
          return (
            <section key={String(running)}>
              <h3>
                {running ? "正在运行" : "已结束"} · {group.length}
              </h3>
              {group.slice(0, running ? undefined : limit).map((task) => {
                const Icon = task.waitingForInput
                  ? PauseCircle
                  : task.status === "running"
                    ? LoaderCircle
                    : task.status === "error"
                      ? CircleAlert
                      : task.status === "aborted"
                        ? Ban
                        : task.status === "interrupted"
                          ? CircleDashed
                          : CheckCircle2;
                return (
                  <button key={task.agentId} onClick={() => paneTask(openSubagent(task))}>
                    <Icon
                      size={16}
                      className={task.status === "running" && !task.waitingForInput ? "spin" : undefined}
                    />
                    <span>
                      <span className="subagent-directory-title">
                        <strong>{task.description}</strong>
                        <small>{task.waitingForInput ? "等待回答" : subagentStatusLabels[task.status]}</small>
                      </span>
                      {(task.result || task.latestActivity) && (
                        <small className="subagent-directory-summary">
                          {task.result || task.latestActivity}
                        </small>
                      )}
                    </span>
                    <time>{formatTaskRelativeTime(task.endedAt ?? task.startedAt, now)}</time>
                  </button>
                );
              })}
              {!running && group.length > limit && (
                <button className="subagent-load-more" onClick={() => setLimit(limit + 20)}>
                  再显示20个
                </button>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
