// Local Bash lifecycle and TaskOutput semantics follow ZCode (Apache-2.0).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { getShellConfig, getShellEnv, killProcessTree, type ToolDefinition } from "zpi-coding-agent";
import type { BackgroundTask, BackgroundTaskOutput } from "zpi-ui";
import { processGroupAlive as alive, terminateTaskProcess } from "./task-processes.ts";

interface Port {
  publish(task: BackgroundTask): void;
  notify(task: BackgroundTask): Promise<void>;
  error(error: unknown): void;
}
interface Execution {
  task: BackgroundTask;
  background: boolean;
  done: Promise<void>;
  stop(): void;
  readers: number;
  notified: boolean;
  waiters: Set<() => void>;
}
const parameters = Type.Object(
  {
    command: Type.String(),
    description: Type.Optional(Type.String({ description: "A short description of what this command does" })),
    timeout: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 600000,
        description: "Foreground wait in milliseconds (default 120000, maximum 600000)",
      }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description: "Start a persistent background command and return its task ID immediately",
      }),
    ),
  },
  { additionalProperties: false },
);
const outputLimit = () => Math.min(160000, positive(process.env.TASK_MAX_OUTPUT_LENGTH, 32000));
const positive = (value: string | undefined, fallback: number) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
};
const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
  isError,
});

export class BackgroundTasks {
  private tasks = new Map<string, BackgroundTask>();
  private executions = new Map<string, Execution>();
  private closing = false;
  private dir: string;
  private port: Port;
  constructor(dir: string, port: Port) {
    this.dir = dir;
    this.port = port;
  }

  list(sessionId: string) {
    return [...this.tasks.values()].filter((task) => task.sessionId === sessionId);
  }
  restore(task: BackgroundTask) {
    // Never signal a persisted PID: it may belong to an unrelated process after restart.
    this.tasks.set(
      task.taskId,
      task.status === "running"
        ? {
            ...task,
            status: "lost",
            endedAt: Date.now(),
            error: "Application restarted; process ownership was lost.",
          }
        : task,
    );
  }
  private owned(sessionId: string, taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task || task.sessionId !== sessionId) throw new Error("not_found: 后台任务不存在");
    return task;
  }
  private publish(task: BackgroundTask) {
    this.tasks.set(task.taskId, task);
    try {
      this.port.publish({ ...task });
    } catch (error) {
      this.port.error(error);
    }
  }
  private notify(execution: Execution) {
    if (
      !execution.background ||
      execution.task.status === "running" ||
      execution.task.status === "cancelled" ||
      execution.readers ||
      execution.notified ||
      this.closing
    )
      return;
    execution.notified = true;
    void this.port.notify({ ...execution.task }).catch((error) => this.port.error(error));
  }
  tool(sessionId: string, cwd: string, child = false): ToolDefinition {
    return {
      name: "bash",
      label: "Bash",
      parameters,
      description:
        "Execute a shell command. timeout is in milliseconds (default 120000, max 600000). Use run_in_background for servers, watchers and long-running work. Eligible foreground commands automatically continue in the background at the timeout; plain sleep commands time out instead. Background tasks survive the current turn and can be read with TaskOutput or stopped with TaskStop. Completion is delivered automatically; do not poll. Output is persisted to a file and previews are bounded.",
      promptSnippet: "Run shell commands, including persistent background servers and watchers",
      execute: async (callId, params, signal, update, context) => {
        if (!Value.Check(parameters, params)) throw new Error("invalid_input: bash 参数无效");
        signal?.throwIfAborted();
        if (this.closing) throw new Error("busy: 后台任务正在关闭");
        if (!params.command.trim()) return textResult("");
        const directory = join(this.dir, "agent", "tool-output", sessionId);
        await mkdir(directory, { recursive: true });
        const taskId = `exec_${randomUUID()}`;
        const outputPath = join(directory, `${taskId}.log`);
        const file = await open(outputPath, "wx", 0o600);
        const environment = getShellEnv();
        for (const key of [
          "PI_SESSION_ID",
          "PI_SESSION_FILE",
          "PI_PROVIDER",
          "PI_MODEL",
          "PI_REASONING_LEVEL",
          "ZPI_SESSION_ID",
          "ZPI_SESSION_FILE",
          "ZPI_PROVIDER",
          "ZPI_MODEL",
          "ZPI_REASONING_LEVEL",
        ])
          delete environment[key];
        environment.ZPI_SESSION_ID = sessionId;
        const sessionFile = context?.sessionManager.getSessionFile();
        if (sessionFile) environment.ZPI_SESSION_FILE = sessionFile;
        if (context?.model) {
          environment.ZPI_PROVIDER = context.model.provider;
          environment.ZPI_MODEL = context.model.id;
        }
        let shell: ReturnType<typeof getShellConfig>;
        try {
          signal?.throwIfAborted();
          if (this.closing) throw new Error("busy: 后台任务正在关闭");
          shell = getShellConfig();
        } catch (error) {
          await file.close();
          throw error;
        }
        let processChild: ReturnType<typeof spawn>;
        try {
          processChild = spawn(
            shell.shell,
            shell.commandTransport === "stdin" ? shell.args : [...shell.args, params.command],
            {
              cwd,
              env: environment,
              detached: process.platform !== "win32",
              windowsHide: true,
              stdio: [shell.commandTransport === "stdin" ? "pipe" : "ignore", file.fd, file.fd],
            },
          );
        } catch (error) {
          await file.close();
          throw error;
        }
        let finish!: () => void;
        let resolveOutcome!: (background: boolean) => void;
        const outcome = new Promise<boolean>((resolve) => {
          resolveOutcome = resolve;
        });
        let rootExited = false;
        let settled = false;
        let stopped = false;
        let terminating: Promise<void> | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let watchdog: ReturnType<typeof setInterval> | undefined;
        let lifetime: ReturnType<typeof setTimeout> | undefined;
        let observing = false;
        const execution: Execution = {
          task: {
            taskId,
            sessionId,
            toolCallId: callId,
            command: params.command,
            description: params.description || params.command.slice(0, 200),
            status: "running",
            startedAt: Date.now(),
            outputPath,
          },
          background: false,
          readers: 0,
          notified: false,
          waiters: new Set(),
          done: new Promise<void>((resolve) => {
            finish = resolve;
          }),
          stop: () => {
            if (settled || stopped) return;
            stopped = true;
            if (processChild.pid) terminating = terminateTaskProcess(processChild.pid);
          },
        };
        this.executions.set(taskId, execution);
        const abort = () => execution.stop();
        signal?.addEventListener("abort", abort, { once: true });
        const settle = async (code: number | null, error?: string) => {
          if (settled) return;
          settled = true;
          await terminating;
          clearTimeout(timeout);
          clearInterval(watchdog);
          clearTimeout(lifetime);
          signal?.removeEventListener("abort", abort);
          execution.task = {
            ...execution.task,
            status:
              error || execution.task.error
                ? "failed"
                : stopped
                  ? "cancelled"
                  : code !== 0
                    ? "failed"
                    : "completed",
            endedAt: Date.now(),
            exitCode: code,
            ...(error ? { error } : {}),
          };
          await file.close().catch((failure) => this.port.error(failure));
          if (execution.background) this.publish(execution.task);
          finish();
          for (const wake of execution.waiters) wake();
          execution.waiters.clear();
          resolveOutcome(false);
          // Waiters reserve notification ownership before reading the final output file.
          this.notify(execution);
          this.executions.delete(taskId);
        };
        const commitBackground = () => {
          if (settled || rootExited || stopped || execution.background) return;
          execution.background = true;
          execution.task = { ...execution.task, autoBackgrounded: !params.run_in_background };
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          this.publish(execution.task);
          if (child) lifetime = setTimeout(execution.stop, 3600000);
          resolveOutcome(true);
        };
        processChild.once("error", (error) => {
          void settle(null, error.message);
        });
        processChild.once("exit", (code, exitSignal) => {
          rootExited = true;
          clearTimeout(timeout);
          execution.task.exitCode = code ?? (exitSignal ? 128 + constants.signals[exitSignal] : null);
          if (!execution.background || !alive(processChild.pid)) void settle(execution.task.exitCode);
        });
        processChild.once("spawn", () => {
          execution.task.pid = processChild.pid;
          if (signal?.aborted || this.closing) execution.stop();
          if (stopped && processChild.pid) killProcessTree(processChild.pid);
          if (shell.commandTransport === "stdin") {
            processChild.stdin?.on("error", () => {});
            processChild.stdin?.end(`${params.command}\n`);
          }
          if (params.run_in_background) commitBackground();
          else {
            const defaultTimeout = positive(process.env.BASH_DEFAULT_TIMEOUT_MS, 120000);
            const maxTimeout = Math.max(defaultTimeout, positive(process.env.BASH_MAX_TIMEOUT_MS, 600000));
            const waitMs = Math.min(params.timeout ?? defaultTimeout, maxTimeout);
            timeout = setTimeout(() => {
              if (params.command.trim().split(/\s+/)[0] === "sleep") {
                execution.task.error = `Command timed out after ${waitMs} ms.`;
                execution.stop();
              } else commitBackground();
            }, waitMs);
          }
          // Direct file output has no pipe buffers or unbounded JS strings. One bounded watchdog per process.
          watchdog = setInterval(() => {
            if (observing || settled) return;
            observing = true;
            void (async () => {
              if (rootExited && !alive(processChild.pid)) {
                await settle(execution.task.exitCode ?? null);
                return;
              }
              const size = (await stat(outputPath)).size;
              if (execution.background && size >= 5 * 1024 ** 3) {
                execution.task.error = "Background output exceeded 5 GiB.";
                execution.stop();
              }
              if (!execution.background && update) {
                const preview = await this.readFile(execution.task, false, 32000);
                if (!settled && !execution.background) update(textResult(preview.output));
              }
            })()
              .catch((error) => {
                if (!settled) {
                  this.port.error(error);
                  execution.stop();
                }
              })
              .finally(() => {
                observing = false;
              });
          }, 1000);
        });
        const background = await outcome;
        if (background)
          return textResult(
            `Command running in background with ID: ${taskId}. Output is being written to: ${outputPath}\nUse TaskOutput to read output or TaskStop to stop it. Completion will be delivered automatically.`,
          );
        signal?.throwIfAborted();
        const preview = await this.readFile(execution.task, false, outputLimit());
        if (!preview.truncated)
          await rm(outputPath, { force: true }).catch((error) => this.port.error(error));
        return textResult(
          `${preview.output || "(no output)"}${preview.truncated ? `\n[Output truncated. Full output: ${outputPath}]` : ""}${execution.task.error ? `\n${execution.task.error}` : ""}${execution.task.status === "completed" ? "" : `\nCommand ${execution.task.status} (exit code ${execution.task.exitCode ?? "unknown"})`}`,
          execution.task.status !== "completed",
        );
      },
    };
  }
  private async readFile(
    task: BackgroundTask,
    prefix: boolean,
    maxBytes: number,
  ): Promise<BackgroundTaskOutput> {
    const file = await open(task.outputPath, "r");
    try {
      const size = (await file.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, maxBytes));
      const start = prefix ? 0 : Math.max(0, size - buffer.length);
      let read = 0;
      while (read < buffer.length) {
        const result = await file.read(buffer, read, buffer.length - read, start + read);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      let output = buffer.subarray(0, read).toString("utf8");
      if (!prefix && start > 0) output = output.replace(/^\uFFFD+/, "");
      return { task: { ...task }, output, truncated: size > read };
    } finally {
      await file.close();
    }
  }
  async read(sessionId: string, taskId: string) {
    const snapshot = await this.readFile({ ...this.owned(sessionId, taskId) }, false, 65536);
    return { ...snapshot, output: stripVTControlCharacters(snapshot.output) };
  }
  async output(
    sessionId: string,
    params: { task_id: string; block?: boolean; timeout?: number },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    this.owned(sessionId, params.task_id);
    const execution = this.executions.get(params.task_id);
    if (execution) execution.readers++;
    try {
      if (params.block !== false && execution)
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: unknown) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            execution.waiters.delete(wake);
            if (error) reject(error);
            else resolve();
          };
          const abort = () => finish(signal?.reason ?? new Error("TaskOutput cancelled"));
          const wake = () => finish();
          const timer = setTimeout(finish, params.timeout ?? 30000);
          signal?.addEventListener("abort", abort, { once: true });
          execution.waiters.add(wake);
        });
      signal?.throwIfAborted();
      const task = { ...this.owned(sessionId, params.task_id) };
      const status =
        task.status === "running" ? (params.block === false ? "not_ready" : "timeout") : "success";
      const preview = await this.readFile(
        task,
        task.status === "running",
        task.status === "running" ? 30000 : 8 * 1024 ** 2,
      );
      signal?.throwIfAborted();
      let output = preview.output;
      const limit = outputLimit();
      const truncated = preview.truncated || output.length > limit;
      output = output.slice(0, limit);
      if (truncated) output += `\n[Output truncated. Full output: ${task.outputPath}]`;
      if (status === "success" && execution) execution.notified = true;
      return {
        content: [
          {
            type: "text" as const,
            text: `<retrieval_status>${status}</retrieval_status>\n\n<task_id>${task.taskId}</task_id>\n\n<task_type>local_bash</task_type>\n\n<status>${task.status}</status>${task.exitCode != null ? `\n\n<exit_code>${task.exitCode}</exit_code>` : ""}\n\n<output>\n${output}\n</output>`,
          },
        ],
        details: {
          retrieval_status: status,
          task: {
            task_id: task.taskId,
            task_type: "local_bash",
            status: task.status,
            description: task.description,
            output,
            exitCode: task.exitCode ?? null,
            outputFile: task.outputPath,
          },
        },
      };
    } finally {
      if (execution) {
        execution.readers--;
        this.notify(execution);
      }
    }
  }
  async stop(sessionId: string, taskId: string, strict = false) {
    const task = this.owned(sessionId, taskId);
    if (task.status !== "running") {
      if (strict) throw new Error("invalid_input: Task is not running");
      return;
    }
    const execution = this.executions.get(taskId);
    if (!execution) throw new Error("not_found: 后台进程不存在");
    execution.stop();
    await execution.done;
  }
  async stopAll(sessionId: string) {
    await Promise.all(
      this.list(sessionId)
        .filter((task) => task.status === "running")
        .map((task) => this.stop(sessionId, task.taskId)),
    );
  }
  forget(sessionId: string) {
    for (const task of this.list(sessionId)) this.tasks.delete(task.taskId);
  }
  async close() {
    this.closing = true;
    const running = [...this.executions.values()];
    for (const execution of running) execution.stop();
    await Promise.all(running.map((execution) => execution.done));
  }
}
