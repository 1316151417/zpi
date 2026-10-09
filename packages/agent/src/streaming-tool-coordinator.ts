import type { AssistantMessage, ToolCall, ToolResultMessage } from "ZPI-ai";
import { createToolExecutor, finishToolCall, toolFailure, toolResultMessage } from "./tool-execution.ts";
import type { AgentContext, AgentEventSink, AgentLoopConfig } from "./types.ts";

const CANCEL_DRAIN_TIMEOUT_MS = 250;

export function shouldExecuteDuringStream(
  context: AgentContext,
  config: AgentLoopConfig,
  call: ToolCall,
): boolean {
  if (!call.name.trim() || config.streamingToolExecution === "off") return false;
  const tool = context.tools?.find((t) => t.name === call.name);
  const metadata = tool?.metadata;
  return !!(
    metadata?.readOnly &&
    metadata.concurrentSafe &&
    !metadata.destructive &&
    !metadata.needsApproval &&
    !(tool?.requiresUserInteraction ?? metadata.requiresUserInteraction) &&
    (tool?.permission?.sideEffectScope ?? metadata.sideEffectScope) === "none"
  );
}

async function withinDrainWindow<T>(promise: Promise<T>): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), CANCEL_DRAIN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** One coordinator per streamed response; no handles survive recovery or cancellation. */
export function createStreamingToolCoordinator(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const handles = new Map<string, Promise<ToolResultMessage | undefined>>();
  const accepted = new Map<string, ToolCall>();
  const ended = new Set<string>();
  let active = true;
  let preparation = Promise.resolve();
  const streamingEmit: AgentEventSink = async (event) => {
    if (!active) return;
    await emit(
      event.type === "tool_execution_start" ? { ...event, executionTiming: "during_stream" } : event,
    );
    if (event.type === "tool_execution_end") ended.add(event.toolCallId);
  };
  function detach() {
    active = false;
    signal?.removeEventListener("abort", abort);
  }
  return {
    accept(call: ToolCall, assistant: AssistantMessage) {
      if (accepted.has(call.id)) return;
      // Arguments belong to the closed call, never to a later mutable stream partial.
      const closed = structuredClone(call);
      accepted.set(call.id, closed);
      if (!shouldExecuteDuringStream(context, config, closed)) return;
      const executor = createToolExecutor(
        context,
        structuredClone(assistant),
        config,
        streamingEmit,
        controller.signal,
      );
      const scheduled = preparation.then(() => executor.schedule(closed));
      preparation = scheduled.then(
        () => undefined,
        () => undefined,
      );
      // Infrastructure failure falls back to normal end-of-stream execution, as in ZCode.
      handles.set(
        closed.id,
        scheduled.then((execute) => execute()).catch(() => undefined),
      );
    },
    async drain(calls: ToolCall[]): Promise<Map<string, ToolResultMessage>> {
      const results = new Map<string, ToolResultMessage>();
      let onCancel: (() => void) | undefined;
      try {
        const completed = Promise.all(calls.map((call) => handles.get(call.id)));
        const cancelled = new Promise<undefined>((resolve) => {
          onCancel = () => resolve(undefined);
          if (signal?.aborted) onCancel();
          else signal?.addEventListener("abort", onCancel, { once: true });
        });
        const settled = await Promise.race([completed, cancelled]);
        if (!settled) return await this.interrupt(calls);
        for (const [index, call] of calls.entries()) {
          const result = settled[index];
          if (result) results.set(call.id, result);
        }
        return results;
      } finally {
        if (onCancel) signal?.removeEventListener("abort", onCancel);
        detach();
      }
    },
    async interrupt(calls: ToolCall[]): Promise<Map<string, ToolResultMessage>> {
      abort();
      const settled = await Promise.all(
        calls.map((call) => {
          const handle = handles.get(call.id);
          return handle ? withinDrainWindow(handle) : undefined;
        }),
      );
      detach();
      const results = new Map<string, ToolResultMessage>();
      for (const [index, call] of calls.entries()) {
        const result = settled[index];
        if (result) {
          results.set(call.id, result);
          continue;
        }
        const reason = handles.has(call.id) ? "unknown_execution_state" : "not_executed";
        const text =
          reason === "not_executed"
            ? "Tool execution was interrupted during streaming recovery before this tool was executed. Treat this tool call as failed and do not retry blindly."
            : "Tool execution was interrupted during streaming recovery before a result was committed. Side effects may be unknown; inspect current state before retrying.";
        if (!handles.has(call.id))
          await emit({
            type: "tool_execution_start",
            toolCallId: call.id,
            toolName: call.name,
            args: call.arguments,
          });
        const failure = {
          ...toolFailure(text),
          details: { type: "stream_recovery_interrupted_tool", reason },
        };
        // A failed infrastructure path may already have emitted end. History still needs a paired result.
        const message = ended.has(call.id)
          ? toolResultMessage(call, failure)
          : await finishToolCall(call, failure, emit);
        results.set(call.id, message);
      }
      return results;
    },
    async abandon() {
      abort();
      await withinDrainWindow(Promise.allSettled(handles.values()));
      detach();
    },
  };
}
