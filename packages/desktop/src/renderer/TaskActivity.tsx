// Combined task status and directory follow ZCode ConversationStatusPanel (Apache-2.0).
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronRight,
  LoaderCircle,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { type BackgroundTask, type SubagentTask, subagentStatusLabels } from "zpi-ui";
import { openBackgroundTask, openSubagent, openTaskDirectory, paneTask } from "./pane-store.ts";
import { unwrap, useStore } from "./store.ts";

type Task = SubagentTask | BackgroundTask;
const emptyAgents: SubagentTask[] = [];
const emptyCommands: BackgroundTask[] = [];
const taskId = (task: Task) => ("taskId" in task ? task.taskId : task.agentId);
export const backgroundStatus = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  lost: "已中断",
};
const statusLabel = (task: Task) =>
  "taskId" in task
    ? backgroundStatus[task.status]
    : task.waitingForInput
      ? "等待回答"
      : subagentStatusLabels[task.status];
const openTask = (task: Task) => ("taskId" in task ? openBackgroundTask(task) : paneTask(openSubagent(task)));
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
function duration(task: Task, now: number) {
  const seconds = Math.max(0, Math.floor(((task.endedAt ?? now) - task.startedAt) / 1000));
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}
function TaskRow({ task, now }: { task: Task; now: number }) {
  const [stopping, setStopping] = useState(false);
  const command = "taskId" in task;
  const kind = command ? "后台任务" : "子智能体";
  return (
    <div className="task-running-row">
      <button aria-label={`查看${kind} ${task.description}`} onClick={() => openTask(task)}>
        {command ? <SquareTerminal size={16} /> : <Bot size={16} data-agent-color={task.color} />}
        <span>
          <strong>{task.description}</strong>
          <small>
            {statusLabel(task)} · {duration(task, now)}
            {!command && task.latestActivity ? ` · ${task.latestActivity}` : ""}
            {command && task.exitCode != null ? ` · 退出码 ${task.exitCode}` : ""}
          </small>
        </span>
      </button>
      {task.status === "running" && (
        <button
          aria-label={`停止${kind} ${task.description}`}
          title={`停止${kind}`}
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            const stop = command
              ? window.zpi.stopBackgroundTask(task.sessionId, task.taskId)
              : window.zpi.stopSubagent(task.parentSessionId, task.agentId);
            paneTask(stop.then(unwrap).finally(() => setStopping(false)));
          }}
        >
          {stopping ? <LoaderCircle size={12} className="spin" /> : <Square size={12} />}
        </button>
      )}
    </div>
  );
}
export const TaskActivity = memo(function TaskActivity({
  agents = emptyAgents,
  commands = emptyCommands,
  sessionId,
}: {
  agents?: SubagentTask[];
  commands?: BackgroundTask[];
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const storageKey = `zpi:tasks-dismissed:${sessionId}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  const tasks = useMemo(() => [...agents, ...commands], [agents, commands]);
  const running = useMemo(
    () => tasks.filter((task) => task.status === "running").sort((a, b) => a.startedAt - b.startedAt),
    [tasks],
  );
  const revision = useMemo(
    () => tasks.map((task) => `${taskId(task)}:${task.startedAt}:${task.endedAt ?? ""}`).join("|"),
    [tasks],
  );
  const ended = tasks.length - running.length;
  const now = useNow(open && running.length > 0);
  if (!tasks.length || (!running.length && dismissed === revision)) return null;
  return (
    <aside
      className="task-activity"
      aria-label="任务状态"
      data-state={open ? "expanded" : "collapsed"}
      data-running={running.length > 0}
    >
      <div className="task-activity-header">
        <button
          className="task-activity-toggle"
          aria-expanded={open}
          aria-label={open ? "收起任务状态" : "展开任务状态"}
          title={
            open
              ? "收起任务状态"
              : `任务 · ${running.length ? `${running.length}个运行中` : `${ended}个已结束`}`
          }
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <>
              {running.length ? <LoaderCircle size={14} className="spin" /> : <CheckCircle2 size={14} />}
              <span>任务</span>
              <span className="task-activity-count">
                {running.length ? `${running.length}个运行中` : `${ended}个已结束`}
              </span>
              <ChevronRight size={14} className="rotated" />
            </>
          ) : (
            <>
              <Activity size={16} />
              <span className="sr-only">
                {running.length ? `${running.length}个运行中` : `${ended}个已结束`}
              </span>
            </>
          )}
        </button>
        {open && !running.length && (
          <button
            className="task-activity-dismiss"
            aria-label="关闭任务状态"
            title="关闭任务状态"
            onClick={() => {
              setDismissed(revision);
              try {
                sessionStorage.setItem(storageKey, revision);
              } catch {
                /* In-memory dismissal still works. */
              }
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {open && (
        <>
          <div className="task-activity-list">
            {running.map((task) => (
              <TaskRow key={taskId(task)} task={task} now={now} />
            ))}
          </div>
          {ended > 0 && (
            <button className="task-ended" onClick={() => openTaskDirectory(sessionId)}>
              <CheckCircle2 size={16} />
              <span>已结束</span>
              <span>{ended}</span>
              <ChevronRight size={14} />
            </button>
          )}
        </>
      )}
    </aside>
  );
});
export function TaskDirectory({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const agents = useStore((state) => state.views.get(sessionId)?.subagents ?? emptyAgents);
  const commands = useStore((state) => state.views.get(sessionId)?.backgroundTasks ?? emptyCommands);
  const [limit, setLimit] = useState(20);
  const tasks = useMemo(() => [...agents, ...commands], [agents, commands]);
  const now = useNow(visible && tasks.some((task) => task.status === "running"));
  return (
    <section className="task-directory" aria-label="任务目录">
      <h2>任务目录</h2>
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
              {group.slice(0, running ? undefined : limit).map((task) => (
                <TaskRow key={taskId(task)} task={task} now={now} />
              ))}
              {!running && group.length > limit && (
                <button className="task-load-more" onClick={() => setLimit(limit + 20)}>
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
