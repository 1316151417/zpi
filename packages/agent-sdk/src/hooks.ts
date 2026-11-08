import { assertSupportedOptions } from "@zpi-dev/ai";
import type { HookRegistration } from "@zpi-dev/coding-agent";
import { decodeHookOutput, hookInputPayload } from "@zpi-dev/plugin-compat";
import type { HookEvent, HookInput, Options } from "./types.ts";

export function coreHooks(options: Options, transcript: string): HookRegistration[] {
  const core = new Set([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
  ]);
  return Object.entries(options.hooks ?? {}).flatMap(([event, groups]) => {
    if (!core.has(event)) return [];
    return (groups ?? []).flatMap((group) =>
      group.hooks.map(
        (callback): HookRegistration => ({
          event: event as HookRegistration["event"],
          matcher: group.matcher,
          timeoutMs: (group.timeout ?? 30) * 1000,
          onError: group.onFailure ?? "continue",
          handler: async (input, signal) => {
            const output = await callback(
              { ...hookInputPayload(input, transcript), transcript_path: transcript } as HookInput,
              "toolCallId" in input ? input.toolCallId : undefined,
              { signal },
            );
            validateHookOutput(output, event as HookEvent);
            return decodeHookOutput(output, input.event);
          },
        }),
      ),
    );
  });
}
export async function lifecycleHook(
  options: Options,
  event: HookEvent,
  input: import("./types.ts").BaseHookInput & {
    agent_id?: string;
    agent_type?: string;
    reason?: string;
    trigger?: "manual" | "auto";
    custom_instructions?: string;
    stop_hook_active?: boolean;
    last_assistant_message?: string;
  },
  signal: AbortSignal,
  report?: (error: unknown) => void,
): Promise<void> {
  for (const group of options.hooks?.[event] ?? []) {
    if (
      group.matcher &&
      !new RegExp(group.matcher).test(input.agent_type ?? input.trigger ?? input.reason ?? "")
    )
      continue;
    for (const callback of group.hooks) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error("Hook timed out")),
        (group.timeout ?? 30) * 1000,
      );
      try {
        signal.throwIfAborted();
        const { abortable } = await import("@zpi-dev/ai");
        const output = await abortable(
          callback({ ...input, hook_event_name: event } as HookInput, undefined, {
            signal: controller.signal,
          }),
          controller.signal,
        );
        validateHookOutput(output, event);
        if (
          Object.entries(output).some(
            ([key, value]) => value !== undefined && !(key === "continue" && value === true),
          )
        )
          throw new Error(`${event} hook output is not supported; lifecycle callbacks must return {}`);
      } catch (error) {
        report?.(error);
        if (signal.aborted || group.onFailure === "block") throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    }
  }
}

function validateHookOutput(output: unknown, event: HookEvent): void {
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("Invalid hook output");
  const value = output as Record<string, unknown>;
  if ("async" in value) throw new Error("Async hook output is not supported");
  assertSupportedOptions(
    value,
    ["continue", "stopReason", "decision", "reason", "hookSpecificOutput"],
    "hook output",
  );
  if (value.continue !== undefined && typeof value.continue !== "boolean")
    throw new Error("Invalid hook continue");
  for (const name of ["stopReason", "reason"])
    if (value[name] !== undefined && typeof value[name] !== "string") throw new Error(`Invalid hook ${name}`);
  if (value.decision !== undefined && !["approve", "block"].includes(String(value.decision)))
    throw new Error("Invalid hook decision");
  const specific = value.hookSpecificOutput as Record<string, unknown> | undefined;
  if (
    specific !== undefined &&
    (!specific || typeof specific !== "object" || specific.hookEventName !== event)
  )
    throw new Error("Invalid hookSpecificOutput event");
  if (specific) {
    assertSupportedOptions(
      specific,
      [
        "hookEventName",
        "additionalContext",
        "updatedInput",
        "permissionDecision",
        "permissionDecisionReason",
      ],
      "hookSpecificOutput",
    );
    if (
      specific.permissionDecision !== undefined &&
      !["allow", "deny", "ask"].includes(String(specific.permissionDecision))
    )
      throw new Error("Invalid hook permissionDecision");
    for (const key of ["additionalContext", "permissionDecisionReason"])
      if (specific[key] !== undefined && typeof specific[key] !== "string")
        throw new Error(`Invalid hook ${key}`);
    if (
      specific.updatedInput !== undefined &&
      (!specific.updatedInput ||
        typeof specific.updatedInput !== "object" ||
        Array.isArray(specific.updatedInput))
    )
      throw new Error("Invalid hook updatedInput");
  }
}
