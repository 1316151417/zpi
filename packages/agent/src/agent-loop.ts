import type { ToolCall, ToolResultMessage } from "ZPI-ai";
import { emptyAssistant, getCurrentTools, isJsonValue, normalizeContext, toToolDeclaration } from "ZPI-ai";
import { Check } from "typebox/value";
import type {
  AgentContext,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  AgentToolResult,
  StreamFn,
} from "./types.ts";

const failure = (error: unknown): AgentToolResult => ({
  content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  details: undefined,
  isError: true,
});
function declareTools(context: AgentContext): AgentMessage[] {
  const old = getCurrentTools(context.messages);
  const next = (context.tools ?? []).map(toToolDeclaration);
  const added = next.filter((t) => JSON.stringify(old.find((o) => o.name === t.name)) !== JSON.stringify(t));
  const removed = old.filter((t) => !next.some((n) => n.name === t.name)).map((t) => ({ name: t.name }));
  return added.length || removed.length
    ? [{ role: "system", content: "", toolsAdded: added, toolsRemoved: removed, timestamp: Date.now() }]
    : [];
}
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<AgentMessage[]> {
  return run([...declareTools(context), ...prompts], context, config, emit, signal, streamFn);
}
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<AgentMessage[]> {
  const converted = await config.convertToLlm(context.messages);
  const last = converted.at(-1);
  if (!last || (last.role !== "user" && last.role !== "toolResult"))
    throw new Error("Cannot continue: last message must be user or toolResult");
  return run(declareTools(context), context, config, emit, signal, streamFn);
}
async function run(
  prompts: AgentMessage[],
  initial: AgentContext,
  config: AgentLoopConfig,
  sink: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<AgentMessage[]> {
  let listenerError: unknown;
  const emit: AgentEventSink = async (event) => {
    try {
      await sink(event);
    } catch (e) {
      listenerError = e;
      throw e;
    }
  };
  const context: AgentContext = { messages: [...initial.messages], tools: initial.tools };
  const fresh: AgentMessage[] = [];
  async function add(message: AgentMessage): Promise<void> {
    context.messages.push(message);
    fresh.push(message);
    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });
  }
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  try {
    for (const prompt of prompts) await add(prompt);
    while (true) {
      let assistant = emptyAssistant(config.model);
      let started = false;
      try {
        if (signal?.aborted) throw new Error("Run aborted");
        const transformed = config.transformContext
          ? await config.transformContext([...context.messages], signal)
          : context.messages;
        const transcript = normalizeContext({ messages: await config.convertToLlm(transformed) });
        const {
          model: _,
          convertToLlm: __,
          transformContext: ___,
          getApiKey,
          beforeToolCall: ____,
          afterToolCall: _____,
          toolExecution: ______,
          ...options
        } = config;
        const apiKey = (await getApiKey?.(config.model.provider)) ?? config.apiKey;
        const events = await streamFn(config.model, transcript, { ...options, apiKey, signal });
        for await (const event of events) {
          if (event.type === "start") {
            assistant = event.partial;
            started = true;
            await emit({ type: "message_start", message: assistant });
          } else if (event.type === "done") assistant = event.message;
          else if (event.type === "error") assistant = event.error;
          else {
            assistant = event.partial;
            await emit({ type: "message_update", message: assistant, assistantMessageEvent: event });
          }
        }
        assistant = await events.result();
      } catch (error) {
        if (listenerError) throw listenerError;
        assistant.stopReason = signal?.aborted ? "aborted" : "error";
        assistant.errorMessage = error instanceof Error ? error.message : String(error);
      }
      if (!started) await emit({ type: "message_start", message: assistant });
      context.messages.push(assistant);
      fresh.push(assistant);
      await emit({ type: "message_end", message: assistant });
      const calls = assistant.content.filter((c) => c.type === "toolCall");
      const results: ToolResultMessage[] = [];
      if (calls.length) {
        // Preparation is ordered, even for a parallel batch.
        const prepare = async (call: ToolCall) => {
          const tool = context.tools?.find((t) => t.name === call.name);
          let args: unknown = call.arguments;
          let error: AgentToolResult | undefined;
          try {
            if (signal?.aborted || assistant.stopReason === "aborted")
              throw new Error("Tool cancelled before execution; effects unknown");
            if (assistant.stopReason === "error")
              throw new Error("Tool not executed: provider response failed");
            if (assistant.stopReason === "length")
              throw new Error("Tool not executed: output length limit may have truncated arguments");
            if (!tool) throw new Error(`Unknown tool: ${call.name}`);
            args = tool.prepareArguments ? tool.prepareArguments(args) : args;
            if (!Check(tool.parameters, args)) throw new Error(`Invalid arguments for tool ${call.name}`);
            const blocked = await config.beforeToolCall?.(
              { assistantMessage: assistant, toolCall: call, args, context },
              signal,
            );
            if (blocked?.block) throw new Error(blocked.reason ?? "Tool blocked by hook");
          } catch (e) {
            error = failure(e);
          }
          return { call, tool, args, error };
        };
        const execute = async (prepared: Awaited<ReturnType<typeof prepare>>): Promise<ToolResultMessage> => {
          const { call, tool, args } = prepared;
          let result = prepared.error;
          let alive = true;
          let updateError: unknown;
          let updates = Promise.resolve();
          await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args });
          try {
            if (!result) {
              if (signal?.aborted) throw new Error("Tool cancelled before execution");
              result = await tool?.execute(call.id, args, signal, (partialResult) => {
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
                  .catch((e) => {
                    updateError ??= e;
                  });
              });
              if (!result) throw new Error("Tool returned no result");
            }
          } catch (e) {
            result = failure(e);
          } finally {
            alive = false;
            await updates;
          }
          if (!result) result = failure("Tool returned no result");
          if (signal?.aborted)
            result = {
              ...result,
              isError: true,
              content: [
                ...result.content,
                { type: "text", text: "Tool cancelled; side effects may have occurred." },
              ],
            };
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
            // Reject circular/non-JSON tool details before recording or IPC.
            if (result.details !== undefined && !isJsonValue(result.details))
              throw new Error("Tool details must be JSON serializable");
          } catch (e) {
            result = failure(e);
          }
          if (updateError) throw updateError;
          await emit({
            type: "tool_execution_end",
            toolCallId: call.id,
            toolName: call.name,
            result,
            isError: result.isError ?? false,
          });
          return {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: result.content,
            details: result.details,
            isError: result.isError ?? false,
            timestamp: Date.now(),
          };
        };
        const sequential =
          config.toolExecution === "sequential" ||
          calls.some((c) => context.tools?.find((t) => t.name === c.name)?.executionMode === "sequential");
        if (sequential) {
          for (const c of calls) {
            const r = await execute(await prepare(c));
            results.push(r);
            await add(r);
          }
        } else {
          const prepared = [];
          for (const c of calls) prepared.push(await prepare(c));
          const outcomes = await Promise.allSettled(prepared.map(execute));
          for (const outcome of outcomes) {
            if (outcome.status === "fulfilled") {
              results.push(outcome.value);
              await add(outcome.value);
            }
          }
          const rejected = outcomes.find((o) => o.status === "rejected");
          if (rejected?.status === "rejected") throw rejected.reason;
        }
      }
      await emit({ type: "turn_end", message: assistant, toolResults: results });
      if (!calls.length || signal?.aborted || ["error", "aborted", "length"].includes(assistant.stopReason))
        break;
      await emit({ type: "turn_start" });
    }
  } finally {
    await emit({ type: "agent_end", messages: fresh });
  }
  return fresh;
}
