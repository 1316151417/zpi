import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isJsonObject } from "zpi-ai";
import {
  getShellConfig,
  getShellEnv,
  type HookInput,
  type HookOutput,
  type HookRegistration,
  hookEvents,
  killProcessTree,
} from "zpi-coding-agent";

export interface CommandHook {
  event: string;
  matcher?: string;
  type: "command" | "process";
  command: string;
  args: string[];
  timeoutMs: number;
}
export interface CommandHookContext {
  root: string;
  dataDirectory: string;
  id: string;
  name: string;
  transcriptPath?: string;
  env?: Record<string, string | undefined>;
  validate?: () => void;
}
const maxFileBytes = 2 * 1024 * 1024;
const maxOutputBytes = 128 * 1024;
function fail(message: string): never {
  throw new Error(`configuration: 钩子：${message}`);
}
const aliases: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Edit: "edit",
  Write: "write",
  Task: "Agent",
};
function matcher(value: unknown): string | undefined {
  if (value === undefined || value === "" || value === "*") return undefined;
  if (typeof value !== "string") fail("hook matcher 必须是字符串");
  let pattern: RegExp;
  try {
    pattern = new RegExp(value);
  } catch {
    fail("hook matcher 正则表达式无效");
  }
  const nativeNames = Object.entries(aliases)
    .filter(([alias]) => pattern.test(alias))
    .map(([, native]) => native);
  return nativeNames.length ? `(?:${value})|^(?:${nativeNames.join("|")})$` : value;
}
export function parseCommandHook(hook: unknown, event: string, match: unknown): CommandHook {
  if (!(hookEvents as readonly string[]).includes(event)) fail(`暂不支持 hook 事件：${event}`);
  if (
    !isJsonObject(hook) ||
    !["command", "process"].includes(hook.type as string) ||
    typeof hook.command !== "string" ||
    !hook.command.trim()
  )
    fail("只支持 command/process hooks");
  if (
    Object.keys(hook).some(
      (key) => !["type", "command", "args", "timeout", "timeoutMs", "statusMessage", "async"].includes(key),
    ) ||
    (hook.async !== undefined && hook.async !== false)
  )
    fail("暂不支持此 hook 字段或异步 hook");
  if (
    (hook.timeout !== undefined && typeof hook.timeout !== "number") ||
    (hook.timeoutMs !== undefined && typeof hook.timeoutMs !== "number")
  )
    fail("hook 超时必须是数字");
  const timeoutMs = hook.timeoutMs ?? (typeof hook.timeout === "number" ? hook.timeout * 1000 : 30000);
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300000
  )
    fail("hook 超时必须在 1–300000 毫秒之间");
  const args = hook.args === undefined ? [] : hook.args;
  if (
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string") ||
    (hook.type === "command" && args.length)
  )
    fail("hook args 无效；command 使用 shell 字符串，process 使用 argv");
  return {
    event,
    matcher: matcher(match),
    type: hook.type as CommandHook["type"],
    command: hook.command,
    args: args as string[],
    timeoutMs,
  };
}

export function decodeHookOutput(value: unknown, event: HookInput["event"]): HookOutput | undefined {
  if (!isJsonObject(value)) fail("hook 输出必须是 JSON 对象");
  const specific = isJsonObject(value.hookSpecificOutput) ? value.hookSpecificOutput : {};
  if (specific.hookEventName !== undefined && specific.hookEventName !== event) fail("hook 输出事件不匹配");
  const context = specific.additionalContext ?? value.additionalContext ?? value.additional_context;
  const reason = specific.permissionDecisionReason ?? value.reason ?? value.stopReason;
  const block =
    value.block === true ||
    value.continue === false ||
    value.decision === "block" ||
    ["deny", "ask"].includes(specific.permissionDecision as string);
  if (
    (context !== undefined && typeof context !== "string") ||
    (reason !== undefined && typeof reason !== "string")
  )
    fail("hook 上下文或理由必须是字符串");
  if (event === "Stop" && block)
    return { additionalContext: (reason as string) || "Hook requested another verification." };
  const updatedInput = specific.updatedInput ?? value.updatedInput;
  return {
    ...(context ? { additionalContext: context as string } : {}),
    ...(block ? { block: true, reason: reason as string | undefined } : {}),
    ...(updatedInput !== undefined ? { updatedInput } : {}),
  };
}
export function hookInputPayload(input: HookInput, transcriptPath?: string) {
  return {
    ...input,
    hookEventName: input.event,
    hook_event_name: input.event,
    session_id: input.sessionId,
    ...(transcriptPath ? { transcriptPath: transcriptPath, transcript_path: transcriptPath } : {}),
    ...("toolName" in input
      ? {
          tool_name:
            Object.entries(aliases).find(([, native]) => native === input.toolName)?.[0] ?? input.toolName,
          tool_input: input.toolInput,
          tool_use_id: input.toolCallId,
          tool_response: input.toolResult,
          error: input.toolResult?.isError ? JSON.stringify(input.toolResult.content) : undefined,
        }
      : {}),
    ...(input.event === "Stop"
      ? { stop_hook_active: input.stopHookActive, last_assistant_message: input.response }
      : {}),
    ...(input.event === "Notification" ? { notification_type: input.notificationType } : {}),
  };
}
async function commandHook(
  hook: CommandHook,
  input: HookInput,
  data: CommandHookContext,
  signal: AbortSignal,
): Promise<HookOutput | undefined> {
  signal.throwIfAborted();
  const pluginData = data.dataDirectory;
  await mkdir(pluginData, { recursive: true, mode: 0o700 });
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = {
    ...(data.env ?? getShellEnv()),
    ZPI_PROJECT_DIR: input.cwd,
    ZCODE_PROJECT_DIR: input.cwd,
    CLAUDE_PROJECT_DIR: input.cwd,
  };
  for (const prefix of ["ZPI", "ZCODE", "CLAUDE"])
    Object.assign(env, {
      [`${prefix}_PLUGIN_ROOT`]: data.root,
      [`${prefix}_PLUGIN_DATA`]: pluginData,
      [`${prefix}_PLUGIN_ID`]: data.id,
      [`${prefix}_PLUGIN_NAME`]: data.name,
    });
  const expand = (text: string) =>
    text.replace(/\$\{((?:ZPI|ZCODE|CLAUDE)_PLUGIN_(?:ROOT|DATA))\}/g, (_, key: string) => env[key] ?? "");
  const payload = hookInputPayload(input, data.transcriptPath);
  const stdin = JSON.stringify(payload);
  if (Buffer.byteLength(stdin) > maxFileBytes) fail("hook 输入超过 2 MiB");
  const invocation =
    hook.type === "process"
      ? { executable: expand(hook.command), args: hook.args.map(expand) }
      : (() => {
          const shell = getShellConfig();
          return { executable: shell.shell, args: [...shell.args, hook.command] };
        })();
  const child = spawn(invocation.executable, invocation.args, {
    cwd: input.cwd,
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: "pipe",
  });
  return new Promise((resolveResult, reject) => {
    const chunks: Buffer[] = [],
      errors: Buffer[] = [];
    let size = 0,
      failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      if (child.pid) killProcessTree(child.pid);
    };
    const abort = () => stop(new Error("Hook cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop(new Error("Hook timed out")), hook.timeoutMs);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxOutputBytes) stop(new Error("Hook output exceeds 128 KiB"));
        else (stream === child.stdout ? chunks : errors).push(Buffer.from(chunk));
      });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
    child.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (failure) {
        reject(failure);
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8").trim();
      const reason = Buffer.concat(errors).toString("utf8").trim() || text;
      if (code === 2 && ["PreToolUse", "UserPromptSubmit", "Stop"].includes(input.event)) {
        resolveResult(
          input.event === "Stop"
            ? { additionalContext: reason || "Hook requested verification." }
            : { block: true, reason: reason || "Blocked by plugin hook" },
        );
        return;
      }
      if (code !== 0) {
        reject(new Error(`Plugin hook exited with code ${code}`));
        return;
      }
      try {
        resolveResult(
          text.startsWith("{") || text.startsWith("[")
            ? decodeHookOutput(JSON.parse(text), input.event)
            : ["SessionStart", "UserPromptSubmit"].includes(input.event) && text
              ? { additionalContext: text }
              : undefined,
        );
      } catch (error) {
        reject(error);
      }
    });
  });
}
export function bindCommandHooks(
  hooks: readonly CommandHook[],
  context: CommandHookContext,
): HookRegistration[] {
  return hooks.map((hook) => ({
    event: hook.event as HookInput["event"],
    matcher: hook.matcher,
    timeoutMs: Math.min(hook.timeoutMs + 1000, 300000),
    onError: "block",
    handler: async (input, signal) => {
      context.validate?.();
      return commandHook(hook, input, context, signal);
    },
  }));
}
