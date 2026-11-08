import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@zpi-dev/agent";
import { abortable, assertSupportedOptions } from "@zpi-dev/ai";
import { Type } from "typebox";
import { Check } from "typebox/value";

export const hookEvents = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "InputAccepted",
  "RunStart",
  "RunEnd",
  "Notification",
] as const;
export type HookEvent = (typeof hookEvents)[number];
export type HookInput = {
  sessionId: string;
  cwd: string;
  invocationId: string;
} & (
  | { event: "SessionStart"; source: "startup" | "resume" }
  | { event: "UserPromptSubmit"; prompt: string }
  | {
      event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure";
      toolCallId: string;
      toolName: string;
      toolInput: unknown;
      toolResult?: AgentToolResult;
    }
  | { event: "Stop"; response: string; stopHookActive: boolean }
  | { event: "InputAccepted"; prompt: string }
  | { event: "RunStart"; runId: string; prompt: string; sessionCreated: boolean; userInitiated: boolean }
  | { event: "RunEnd"; runId: string; status: "completed" | "aborted" | "error" }
  | {
      event: "Notification";
      runId: string;
      notificationType: "task_completed" | "task_failed";
      message: string;
    }
);
type WithoutInvocation<T> = T extends unknown ? Omit<T, "invocationId"> : never;
export type HookInvocation = WithoutInvocation<HookInput>;
export interface HookOutput {
  block?: boolean;
  reason?: string;
  updatedInput?: unknown;
  additionalContext?: string;
}
export interface HookRegistration {
  event: HookEvent;
  matcher?: string;
  timeoutMs?: number;
  onError?: "continue" | "block";
  handler(input: HookInput, signal: AbortSignal): HookOutput | undefined | Promise<HookOutput | undefined>;
}
export interface HookExecution {
  invocationId: string;
  pluginId?: string;
  event: HookEvent;
  index: number;
  status: "completed" | "blocked" | "error" | "cancelled" | "timeout";
  durationMs: number;
  error?: string;
}

const outputSchema = Type.Object(
  {
    block: Type.Optional(Type.Boolean()),
    reason: Type.Optional(Type.String()),
    updatedInput: Type.Optional(Type.Unknown()),
    additionalContext: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export const maxHookContextChars = 24_000;

export function validateHookRegistration(hook: HookRegistration): void {
  if (!hook || !hookEvents.includes(hook.event) || typeof hook.handler !== "function")
    throw new Error("Invalid hook registration");
  assertSupportedOptions(hook, ["event", "matcher", "timeoutMs", "onError", "handler"], "hook");
  if (hook.matcher !== undefined) {
    if (typeof hook.matcher !== "string") throw new Error("Invalid hook matcher");
    if (hook.matcher !== "*") new RegExp(hook.matcher);
  }
  if (
    hook.timeoutMs !== undefined &&
    (!Number.isSafeInteger(hook.timeoutMs) || hook.timeoutMs <= 0 || hook.timeoutMs > 300_000)
  )
    throw new Error("Invalid hook timeout");
  if (hook.onError !== undefined && !["continue", "block"].includes(hook.onError))
    throw new Error("Invalid hook error policy");
}

export class HookRunner {
  private hooks: (HookRegistration & { pluginId?: string })[];
  private observe: (event: HookExecution) => void;
  constructor(
    hooks: readonly (HookRegistration & { pluginId?: string })[],
    observe: (event: HookExecution) => void = () => {},
  ) {
    this.observe = observe;
    this.hooks = hooks.map((hook) => {
      const { pluginId, ...registration } = hook;
      validateHookRegistration(registration);
      return { ...registration, pluginId };
    });
  }
  get hasToolHooks(): boolean {
    return this.hooks.some((hook) =>
      ["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(hook.event),
    );
  }
  async run(
    input: HookInvocation,
    signal?: AbortSignal,
    validateInput?: (input: unknown) => unknown,
  ): Promise<{ block: boolean; reason?: string; updatedInput?: unknown; additionalContexts: string[] }> {
    const eventInput: HookInput = { ...input, invocationId: randomUUID() };
    const result = {
      block: false,
      reason: undefined as string | undefined,
      updatedInput: undefined as unknown,
      additionalContexts: [] as string[],
    };
    let contextChars = 0;
    for (const [index, hook] of this.hooks.entries()) {
      const match =
        "toolName" in eventInput
          ? eventInput.toolName
          : eventInput.event === "Notification"
            ? eventInput.notificationType
            : eventInput.event === "SessionStart"
              ? eventInput.source
              : "";
      if (
        hook.event !== eventInput.event ||
        (hook.matcher && hook.matcher !== "*" && !new RegExp(hook.matcher).test(match))
      )
        continue;
      signal?.throwIfAborted();
      const started = Date.now();
      let timedOut = false;
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("Hook timed out"));
      }, hook.timeoutMs ?? 30_000);
      let status: HookExecution["status"] = "completed";
      let diagnostic: string | undefined;
      let updatingInput = false;
      try {
        const returned = await abortable(
          Promise.resolve().then(() => hook.handler(structuredClone(eventInput), controller.signal)),
          controller.signal,
        );
        const output = returned === undefined ? undefined : structuredClone(returned);
        signal?.throwIfAborted();
        if (output !== undefined && !Check(outputSchema, output)) throw new Error("Invalid hook output");
        if (output?.block && ["PreToolUse", "UserPromptSubmit"].includes(input.event)) {
          result.block = true;
          result.reason ??= output.reason?.slice(0, 4_000) || "Blocked by hook";
          status = "blocked";
        }
        if (output?.updatedInput !== undefined) {
          updatingInput = true;
          if (input.event !== "PreToolUse" || !validateInput)
            throw new Error("updatedInput requires PreToolUse");
          result.updatedInput = validateInput(output.updatedInput);
          if ("toolInput" in eventInput) eventInput.toolInput = structuredClone(result.updatedInput);
          updatingInput = false;
        }
        if (output?.additionalContext) {
          contextChars += output.additionalContext.length;
          if (contextChars > maxHookContextChars) throw new Error("Hook context budget exceeded");
          result.additionalContexts.push(output.additionalContext);
        }
      } catch (error) {
        diagnostic = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
        status = signal?.aborted ? "cancelled" : timedOut ? "timeout" : "error";
        if (signal?.aborted) throw error;
        if (
          (input.event === "PreToolUse" || input.event === "UserPromptSubmit") &&
          (hook.onError === "block" || updatingInput)
        ) {
          result.block = true;
          result.reason ??= `${input.event} hook failed`;
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.observe({
          ...(diagnostic ? { error: diagnostic } : {}),
          invocationId: eventInput.invocationId,
          pluginId: hook.pluginId,
          event: input.event,
          index,
          status,
          durationMs: Date.now() - started,
        });
      }
    }
    return result;
  }
}
