// Adapted from ZCode ConversationStatusPanel.tsx at aac47556 (Apache-2.0).
import * as Collapsible from "@radix-ui/react-collapsible";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Activity,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { ActionHint, type BackgroundTask, type SubagentTask, subagentStatusLabels } from "zpi-ui";
import { openBackgroundTask, openSubagent, openTaskDirectory, paneTask } from "./pane-store.ts";
import { unwrap, useStore } from "./store.ts";

type Task = SubagentTask | BackgroundTask;
type PanelMode = "auto" | "panel" | "mini";
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
function durationUnits(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours && `${hours}小时`, minutes && `${minutes}分`, (rest || !seconds) && `${rest}秒`]
    .filter(Boolean)
    .join(" ");
}
function elapsedLabel(task: Task, now: number) {
  const seconds = Math.max(1, Math.floor(((task.endedAt ?? now) - task.startedAt) / 1000));
  return seconds < 60 ? `已运行 ${seconds} 秒` : `已运行 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function TaskRow({ task, now }: { task: Task; now: number }) {
  const [stopping, setStopping] = useState(false);
  const command = "taskId" in task;
  const kind = command ? "后台任务" : "子智能体";
  return (
    <div className="task-running-row" data-task-kind={command ? "terminal" : "agent"}>
      <button
        className="task-row-open"
        aria-label={`查看${kind} ${task.description}`}
        onClick={() => openTask(task)}
      />
      {command ? <SquareTerminal size={16} /> : <Bot size={16} />}
      <div className="task-row-content">
        <span className="task-row-title">{task.description}</span>
        <div className="task-row-detail">
          <span className="task-row-elapsed">
            {task.status === "running"
              ? elapsedLabel(task, now)
              : `${statusLabel(task)} · ${elapsedLabel(task, now)}`}
          </span>
          {task.status === "running" && (
            <button
              className="task-stop"
              aria-label={`停止${kind} ${task.description}`}
              aria-busy={stopping}
              disabled={stopping}
              onClick={(event) => {
                event.stopPropagation();
                setStopping(true);
                const stop = command
                  ? window.zpi.stopBackgroundTask(task.sessionId, task.taskId)
                  : window.zpi.stopSubagent(task.parentSessionId, task.agentId);
                paneTask(stop.then(unwrap).finally(() => setStopping(false)));
              }}
            >
              {stopping ? (
                <LoaderCircle size={12} className="chat-loading-spinner" />
              ) : (
                <Square size={12} fill="currentColor" />
              )}
              停止
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
function TaskSection({
  tasks,
  kind,
  sessionId,
  now,
}: {
  tasks: Task[];
  kind: "terminal" | "agent";
  sessionId: string;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const running = useMemo(
    () => tasks.filter((task) => task.status === "running").sort((a, b) => a.startedAt - b.startedAt),
    [tasks],
  );
  const ended = tasks.length - running.length;
  const title = kind === "terminal" ? "终端" : "智能体";
  const seconds = Math.max(1, Math.floor((now - (running[0]?.startedAt ?? now)) / 1000));
  if (!tasks.length) return null;
  return (
    <Collapsible.Root
      className="task-status-section"
      data-status-section={kind}
      open={open}
      onOpenChange={setOpen}
    >
      <div className="task-section-header">
        <Collapsible.Trigger
          className="task-section-trigger"
          aria-label={`${open ? "收起" : "展开"}${title}`}
        >
          <span>{title}</span>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </Collapsible.Trigger>
        {running.length > 0 && (
          <div className="task-section-summary">
            {!open && (
              <>
                <span>{durationUnits(seconds)}</span>
                <span>·</span>
              </>
            )}
            <span>
              {kind === "agent"
                ? `${running.length} 运行`
                : open
                  ? `${running.length} 个后台运行`
                  : `${running.length} 后台`}
            </span>
          </div>
        )}
      </div>
      <Collapsible.Content className="tool-content-shell">
        <div className="tool-content-fade">
          <div className="task-activity-list">
            {running.map((task) => (
              <TaskRow key={taskId(task)} task={task} now={now} />
            ))}
          </div>
          {ended > 0 && (
            <div className="task-ended-container" data-separated={running.length > 0}>
              <button className="task-ended" onClick={() => openTaskDirectory(sessionId)}>
                <CheckCircle2 size={16} />
                <span>已结束</span>
                <span>{ended}</span>
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
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
  const [mode, setMode] = useState<PanelMode>("auto");
  const storageKey = `zpi:tasks-dismissed:${sessionId}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  const tasks = useMemo(() => [...agents, ...commands], [agents, commands]);
  const runningAgents = useMemo(() => agents.filter((task) => task.status === "running").length, [agents]);
  const runningCommands = useMemo(
    () => commands.filter((task) => task.status === "running").length,
    [commands],
  );
  const running = runningAgents + runningCommands;
  const revision = useMemo(
    () => tasks.map((task) => `${taskId(task)}:${task.startedAt}:${task.endedAt ?? ""}`).join("|"),
    [tasks],
  );
  const now = useNow(running > 0);
  const SummaryIcon = !running
    ? CheckCircle2
    : runningAgents && runningCommands
      ? Activity
      : runningCommands
        ? SquareTerminal
        : Bot;
  if (!tasks.length || (!running && dismissed === revision)) return null;
  return (
    <aside
      className="task-activity"
      aria-label="任务状态"
      data-state={mode === "mini" ? "collapsed" : "expanded"}
      data-display-mode={mode}
      data-running={running > 0}
    >
      <div className="task-activity-controls">
        <Menu.Root>
          <ActionHint label="状态面板展开策略" side="left" appearance="control">
            <Menu.Trigger className="task-activity-control" aria-label="状态面板展开策略">
              <Ellipsis size={14} />
            </Menu.Trigger>
          </ActionHint>
          <Menu.Portal>
            <Menu.Content className="parity-menu task-activity-menu" align="end" side="bottom" sideOffset={2}>
              <Menu.RadioGroup value={mode} onValueChange={() => setMode("auto")}>
                <Menu.RadioItem className="parity-menu-radio" value="auto">
                  自动展开
                  <Menu.ItemIndicator className="parity-menu-indicator">
                    <Check size={16} />
                  </Menu.ItemIndicator>
                </Menu.RadioItem>
              </Menu.RadioGroup>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        <ActionHint label="收起为胶囊" side="left" appearance="control">
          <button className="task-activity-control" aria-label="收起为胶囊" onClick={() => setMode("mini")}>
            <Minimize2 size={14} />
          </button>
        </ActionHint>
        {!running && (
          <ActionHint label="关闭任务状态" side="left" appearance="control">
            <button
              className="task-activity-control"
              aria-label="关闭任务状态"
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
          </ActionHint>
        )}
      </div>
      <div className="task-activity-sections">
        <TaskSection tasks={commands} kind="terminal" now={now} sessionId={sessionId} />
        <TaskSection tasks={agents} kind="agent" now={now} sessionId={sessionId} />
      </div>
      <ActionHint label="展开状态" side="left" sideOffset={4} appearance="control">
        <button className="task-activity-toggle" aria-label="展开状态" onClick={() => setMode("panel")}>
          <span className="task-summary-icon">
            <SummaryIcon size={16} />
            <Maximize2 size={16} />
          </span>
          <span>{running ? `${running} ${runningAgents ? "运行" : "后台"}` : `${tasks.length} 已结束`}</span>
        </button>
      </ActionHint>
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
