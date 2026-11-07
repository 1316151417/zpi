import type { HookRegistration } from "zpi-coding-agent";
import { decodeHookOutput, hookInputPayload } from "zpi-plugin-compat";
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
            if ("async" in output) throw new Error("Async hook output is not supported");
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
        const { abortable } = await import("zpi-ai");
        await abortable(
          callback({ ...input, hook_event_name: event } as HookInput, undefined, {
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch (error) {
        if (signal.aborted || group.onFailure === "block") throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    }
  }
}
