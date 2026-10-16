import { createLocalBashOperations, getShellEnv } from "zpi-coding-agent";

export interface CustomCommandShellContext {
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
}
export type CustomCommandShellRunner = (
  command: string,
  context: CustomCommandShellContext,
) => Promise<string>;
const maxOutputBytes = 128 * 1024;

/** Reuses the same process-tree, timeout and cancellation backend as the ordinary Bash tool. */
export async function runCustomCommandShell(
  command: string,
  context: CustomCommandShellContext,
  operations = createLocalBashOperations(),
): Promise<string> {
  context.signal.throwIfAborted();
  if (!command.trim()) return "";
  for (const match of command.matchAll(/\$\{((?:CLAUDE|ZCODE|ZPI)_(?:PLUGIN|SKILL)_[A-Z_]+)\}/g)) {
    throw new Error(`invalid_input: 命令 Shell 变量缺少插件或技能上下文：${match[1]}`);
  }
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let bytes = 0;
  const result = await operations.exec(command, context.cwd, {
    signal: context.signal,
    timeout: 30,
    env: {
      ...getShellEnv(),
      ZPI_PROJECT_DIR: context.cwd,
      ZCODE_PROJECT_DIR: context.cwd,
      CLAUDE_PROJECT_DIR: context.cwd,
      ZPI_SESSION_ID: context.sessionId,
      ZCODE_SESSION_ID: context.sessionId,
      CLAUDE_SESSION_ID: context.sessionId,
      CLAUDE_CODE_SESSION_ID: context.sessionId,
    },
    onData(data, stream) {
      bytes += data.length;
      if (bytes > maxOutputBytes) throw new Error("命令 Shell 输出超过 128 KiB 限制");
      (stream === "stderr" ? stderr : stdout).push(Buffer.from(data));
    },
  });
  context.signal.throwIfAborted();
  if (result.exitCode !== 0) {
    const detail = Buffer.concat(stderr.length ? stderr : stdout)
      .toString("utf8")
      .trim()
      .slice(0, 2000);
    throw new Error(
      `命令 Shell 执行失败（退出码 ${result.exitCode ?? "unknown"}）${detail ? `：${detail}` : ""}`,
    );
  }
  return Buffer.concat(stdout).toString("utf8").trimEnd();
}
