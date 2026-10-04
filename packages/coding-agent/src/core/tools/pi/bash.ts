// Adapted from Pi c20cb09772bf4e2590a316cb54514cef76df4293.
// Copyright (c) 2025 Mario Zechner. MIT license: THIRD_PARTY_NOTICES.md.
const BASH_UPDATE_THROTTLE_MS = 100;

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "./compat.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";
import { waitForChildProcess } from "./utils/child-process.ts";
import { getShellConfig, getShellEnv, killProcessTree, type ShellConfig } from "./utils/shell.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
/** Output limit of `structuredContent.output`, which programmatic callers such as codemode scripts receive. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }

  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}

const bashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const bashToolSystemPromptContribution = {
  snippet: "Execute bash commands (ls, grep, find, etc.)",
  guidelines: ["You can inspect ZPI_* environment variables for current model and session details."],
} as const;

/**
 * Result for programmatic callers such as codemode scripts. A non-zero exit code is an error result for the model, but scripts still resolve to this value.
 * `output` is not limited like the model-facing output: callers decide how much of it reaches the model.
 */
const bashOutputSchema = Type.Object({
  output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
  truncated: Type.Boolean(),
  full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
  exit_code: Type.Number(),
  wall_time_seconds: Type.Number(),
});

export type BashToolOutput = Static<typeof bashOutputSchema>;

export interface BashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
  /**
   * Execute a command and stream output.
   * @param command The command to execute
   * @param cwd Working directory
   * @param options Execution options
   * @returns Promise resolving to the exit code. Report signal terminations as 128 + signal number;
   * a null exit code is treated as a failed command.
   */
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(
  shellName: string,
  resolveShellConfig: () => ShellConfig,
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const shellConfig = resolveShellConfig();
      try {
        await fsAccess(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
      }

      const commandFromStdin = shellConfig.commandTransport === "stdin";
      const child = spawn(
        shellConfig.shell,
        commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
        {
          cwd,
          detached: process.platform !== "win32",
          env: env ?? getShellEnv(),
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      if (commandFromStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(command);
      }
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const onAbort = () => {
        if (child.pid) killProcessTree(child.pid);
      };

      try {
        // Set timeout if provided.
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, timeoutMs);
        }
        // Stream stdout and stderr.
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        // Handle abort signal by killing the entire process tree.
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        // Handle shell spawn errors and wait for the process to terminate without hanging
        // on inherited stdio handles held by detached descendants.
        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) {
          throw new Error("aborted");
        }
        if (timedOut) {
          throw new Error(`timeout:${timeout}`);
        }
        // A signal-killed shell has no exit code. Use the standard shell convention so
        // callers do not mistake the termination for a successful command.
        const signalCode = child.signalCode;
        return { exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * Create bash operations using the local shell execution backend.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
  return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

export interface BashSpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
  command: string,
  cwd: string,
  spawnHook: BashSpawnHook | undefined,
  exposeSessionEnvironment: boolean,
  ctx: ExtensionContext | undefined,
): BashSpawnContext {
  const env = { ...getShellEnv() };
  for (const name of ["SESSION_ID", "SESSION_FILE", "PROVIDER", "MODEL", "REASONING_LEVEL"]) {
    delete env[`PI_${name}`];
    delete env[`ZPI_${name}`];
  }
  if (exposeSessionEnvironment && ctx) {
    const model = ctx.model;
    env.ZPI_SESSION_ID = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) env.ZPI_SESSION_FILE = sessionFile;
    if (model) {
      env.ZPI_PROVIDER = model.provider;
      env.ZPI_MODEL = model.id;
    }
    if (ctx.thinkingLevel) env.ZPI_REASONING_LEVEL = ctx.thinkingLevel;
  }
  const baseContext: BashSpawnContext = { command, cwd, env };
  return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
  /** Custom operations for command execution. Default: local shell */
  operations?: BashOperations;
  /** Command prefix prepended to every command (for example shell setup commands) */
  commandPrefix?: string;
  /** Optional explicit shell path from settings */
  shellPath?: string;
  /** Expose current zpi session metadata as ZPI_* environment variables. Default: true */
  exposeSessionEnvironment?: boolean;
  /** Hook to adjust command, cwd, or env before execution */
  spawnHook?: BashSpawnHook;
}

export interface ShellToolConfig {
  name: string;
  label: string;
  shellName: string;
  promptSnippet: string;
  promptGuidelines?: readonly string[];
  tempFilePrefix: string;
}

export function createShellToolDefinition(
  cwd: string,
  config: ShellToolConfig,
  options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
  const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
  const commandPrefix = options?.commandPrefix;
  const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
  const spawnHook = options?.spawnHook;
  return {
    name: config.name,
    label: config.label,
    description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    promptSnippet: config.promptSnippet,
    promptGuidelines:
      exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
    parameters: bashSchema,
    outputSchema: bashOutputSchema,
    async execute(
      _toolCallId,
      { command, timeout }: { command: string; timeout?: number },
      signal?: AbortSignal,
      onUpdate?,
      ctx?: ExtensionContext,
    ) {
      const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
      const spawnContext = resolveSpawnContext(
        resolvedCommand,
        ctx?.cwd || cwd,
        spawnHook,
        exposeSessionEnvironment,
        ctx,
      );
      const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
      let acceptingOutput = true;
      let updateTimer: NodeJS.Timeout | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;

      const emitOutputUpdate = () => {
        if (!onUpdate || !updateDirty) return;
        updateDirty = false;
        lastUpdateAt = Date.now();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        onUpdate({
          content: [{ type: "text", text: snapshot.content || "" }],
          details: {
            truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
            fullOutputPath: snapshot.fullOutputPath,
          },
        });
      };

      const clearUpdateTimer = () => {
        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }
      };

      const scheduleOutputUpdate = () => {
        if (!onUpdate) return;
        updateDirty = true;
        const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
        if (delay <= 0) {
          clearUpdateTimer();
          emitOutputUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitOutputUpdate();
        }, delay);
      };

      if (onUpdate) {
        onUpdate({ content: [], details: undefined });
      }

      const handleData = (data: Buffer) => {
        if (!acceptingOutput) return;
        output.append(data);
        scheduleOutputUpdate();
      };

      const finishOutput = async () => {
        acceptingOutput = false;
        output.finish();
        clearUpdateTimer();
        emitOutputUpdate();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        await output.closeTempFile();
        return snapshot;
      };

      const formatOutput = (
        snapshot: Awaited<ReturnType<typeof finishOutput>>,
        emptyText = "(no output)",
      ) => {
        const truncation = snapshot.truncation;
        let text = snapshot.content || emptyText;
        let details: BashToolDetails | undefined;
        if (truncation.truncated) {
          details = { truncation, fullOutputPath: snapshot.fullOutputPath };
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;
          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(output.getLastLineBytes());
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
          } else if (truncation.truncatedBy === "lines") {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
          } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
          }
        }
        return { text, details };
      };

      const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
      const startedAt = performance.now();

      try {
        let exitCode: number | null;
        try {
          const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
            onData: handleData,
            signal,
            timeout,
            env: spawnContext.env,
          });
          exitCode = result.exitCode;
        } catch (err) {
          const snapshot = await finishOutput();
          const { text } = formatOutput(snapshot, "");
          if (err instanceof Error && err.message === "aborted") {
            throw new Error(appendStatus(text, "Command aborted"));
          }
          if (err instanceof Error && err.message.startsWith("timeout:")) {
            const timeoutSecs = err.message.split(":")[1];
            throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
          }
          throw err;
        }

        const snapshot = await finishOutput();
        const { text: outputText, details } = formatOutput(snapshot);
        if (exitCode === null) {
          throw new Error(appendStatus(outputText, "Command terminated without an exit code"));
        }
        const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
        const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
        const structuredContent: BashToolOutput = {
          output: fullOutput.content,
          truncated: fullOutput.truncated,
          ...(fullOutput.truncated && snapshot.fullOutputPath
            ? { full_output_path: snapshot.fullOutputPath }
            : {}),
          exit_code: exitCode,
          wall_time_seconds: wallTimeSeconds,
        };
        if (exitCode !== 0) {
          return {
            content: [
              { type: "text", text: appendStatus(outputText, `Command exited with code ${exitCode}`) },
            ],
            details,
            structuredContent,
            isError: true,
          };
        }
        return { content: [{ type: "text", text: outputText }], details, structuredContent };
      } finally {
        clearUpdateTimer();
      }
    },
  };
}

const bashToolConfig: ShellToolConfig = {
  name: "bash",
  label: "bash",
  shellName: "bash",
  promptSnippet: bashToolSystemPromptContribution.snippet,
  promptGuidelines: bashToolSystemPromptContribution.guidelines,
  tempFilePrefix: "zpi-bash",
};

export function createBashToolDefinition(
  cwd: string,
  options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
  return createShellToolDefinition(cwd, bashToolConfig, options);
}
