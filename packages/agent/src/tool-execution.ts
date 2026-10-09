import type { AssistantMessage, ToolCall, ToolResultMessage } from "ZPI-ai";
import { isJsonValue } from "ZPI-ai";
import { Check } from "typebox/value";
import type { AgentContext, AgentEventSink, AgentLoopConfig, AgentTool, AgentToolResult } from "./types.ts";

export const toolFailure = (error: unknown): AgentToolResult => ({
  content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  details: undefined,
  isError: true,
});

interface PreparedCall {
  call: ToolCall;
  tool?: AgentTool;
  args: unknown;
  error?: AgentToolResult;
}

export function toolResultMessage(call: ToolCall, result: AgentToolResult): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    details: result.details,
    isError: result.isError ?? false,
    timestamp: Date.now(),
  };
}

export async function finishToolCall(
  call: ToolCall,
  result: AgentToolResult,
  emit: AgentEventSink,
): Promise<ToolResultMessage> {
  await emit({
    type: "tool_execution_end",
    toolCallId: call.id,
    toolName: call.name,
    result,
    isError: result.isError ?? false,
  });
  return toolResultMessage(call, result);
}

/** Shared execution path for Pi batches and ZCode's streamed read-only calls. */
export function createToolExecutor(
  context: AgentContext,
  assistant: AssistantMessage,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
) {
  async function finish(call: ToolCall, result: AgentToolResult): Promise<ToolResultMessage> {
    return finishToolCall(call, result, emit);
  }

  async function prepare(call: ToolCall): Promise<PreparedCall> {
    // Pi emits start before validation and the ordered before hook.
    await emit({
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
    const tool = context.tools?.find((t) => t.name === call.name);
    let args: unknown = call.arguments;
    try {
      if (signal?.aborted || assistant.stopReason === "aborted")
        throw new Error("Tool cancelled before execution; effects unknown");
      if (assistant.stopReason === "error") throw new Error("Tool not executed: provider response failed");
      if (assistant.stopReason === "length")
        throw new Error("Tool not executed: output length limit may have truncated arguments");
      if (!tool) throw new Error(`Unknown tool: ${call.name}`);
      args = tool.prepareArguments ? tool.prepareArguments(args) : args;
      if (!Check(tool.parameters, args)) throw new Error(`Invalid arguments for tool ${call.name}`);
      const blocked = await config.beforeToolCall?.(
        { assistantMessage: assistant, toolCall: call, args, context },
        signal,
      );
      if (signal?.aborted) throw new Error("Tool cancelled before execution");
      if (blocked?.block) throw new Error(blocked.reason ?? "Tool blocked by hook");
      return { call, tool, args };
    } catch (error) {
      return { call, tool, args, error: toolFailure(error) };
    }
  }

  async function execute({ call, tool, args }: PreparedCall): Promise<ToolResultMessage> {
    if (signal?.aborted) return finish(call, toolFailure("Tool cancelled before execution"));
    let alive = true;
    let updateError: unknown;
    let updates = Promise.resolve();
    let result: AgentToolResult;
    try {
      const executed = await tool?.execute(call.id, args, signal, (partialResult) => {
        if (!alive) return;
        updates = updates
          .then(() =>
            emit({
              type: "tool_execution_update",
              toolCallId: call.id,
              toolName: call.name,
              args,
              partialResult,
            }),
          )
          .catch((error) => {
            updateError ??= error;
          });
      });
      if (!executed) throw new Error("Tool returned no result");
      result = executed;
    } catch (error) {
      result = toolFailure(error);
    } finally {
      alive = false;
      await updates;
    }
    try {
      const replacement = await config.afterToolCall?.(
        {
          assistantMessage: assistant,
          toolCall: call,
          args,
          context,
          result,
          isError: result.isError ?? false,
        },
        signal,
      );
      if (replacement) result = { ...result, ...replacement };
      if (result.details !== undefined && !isJsonValue(result.details))
        throw new Error("Tool details must be JSON serializable");
    } catch (error) {
      result = toolFailure(error);
    }
    if (updateError) throw updateError;
    return finish(call, result);
  }

  // Preflight failures are finalized immediately and never enter afterToolCall.
  async function schedule(call: ToolCall): Promise<() => Promise<ToolResultMessage>> {
    const prepared = await prepare(call);
    if (prepared.error) {
      const result = await finish(call, prepared.error);
      return async () => result;
    }
    return () => execute(prepared);
  }
  return { schedule };
}
