import type { ToolResultMessage } from "ZPI-ai";
import { emptyAssistant, getCurrentTools, normalizeContext, toToolDeclaration } from "ZPI-ai";
import { createStreamingToolCoordinator } from "./streaming-tool-coordinator.ts";
import { createToolExecutor } from "./tool-execution.ts";
import type { AgentContext, AgentEventSink, AgentLoopConfig, AgentMessage, StreamFn } from "./types.ts";

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
      let coordinator = createStreamingToolCoordinator(context, config, emit, signal);
      let streamed = new Map<string, ToolResultMessage>();
      let recovering = false;
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
          streamingToolExecution: _______,
          prepareNextTurnWithContext: ________,
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
            if (event.type === "reset") {
              const closed = assistant.content.filter((c) => c.type === "toolCall");
              streamed = await coordinator.interrupt(closed);
              recovering = closed.length > 0;
              if (!recovering) coordinator = createStreamingToolCoordinator(context, config, emit, signal);
            } else if (event.type === "toolcall_end" && !recovering) {
              coordinator.accept(event.toolCall, assistant);
            }
          }
        }
        assistant = await events.result();
      } catch (error) {
        if (listenerError) {
          await coordinator.abandon();
          throw listenerError;
        }
        assistant.stopReason = signal?.aborted ? "aborted" : "error";
        assistant.errorMessage = error instanceof Error ? error.message : String(error);
      }
      const calls = assistant.content.filter((c) => c.type === "toolCall");
      try {
        if (!recovering) {
          streamed =
            signal?.aborted || ["error", "aborted", "length"].includes(assistant.stopReason)
              ? await coordinator.interrupt(calls)
              : await coordinator.drain(calls);
        }
        if (listenerError) throw listenerError;
        if (!started) await emit({ type: "message_start", message: assistant });
        context.messages.push(assistant);
        fresh.push(assistant);
        await emit({ type: "message_end", message: assistant });
      } catch (error) {
        await coordinator.abandon();
        throw error;
      }
      const results: ToolResultMessage[] = [];
      if (calls.length) {
        const executor = createToolExecutor(context, assistant, config, emit, signal);
        const sequential =
          config.toolExecution === "sequential" ||
          calls.some((c) => context.tools?.find((t) => t.name === c.name)?.executionMode === "sequential");
        if (sequential) {
          for (const call of calls) {
            const result = streamed.get(call.id) ?? (await (await executor.schedule(call))());
            results.push(result);
            await add(result);
            if (signal?.aborted && !streamed.size) break;
          }
        } else {
          // Pi prepares every call in declaration order before launching the batch.
          const scheduled: (() => Promise<ToolResultMessage>)[] = [];
          for (const call of calls) {
            const result = streamed.get(call.id);
            scheduled.push(result ? async () => result : await executor.schedule(call));
            if (signal?.aborted && !streamed.size) break;
          }
          const outcomes = await Promise.allSettled(scheduled.map((execute) => execute()));
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
      const next = await config.prepareNextTurnWithContext?.(
        { message: assistant, toolResults: results, context, newMessages: fresh },
        signal,
      );
      if (next?.context) {
        context.messages = next.context.messages;
        context.tools = next.context.tools;
      }
      if (signal?.aborted) break;
      await emit({ type: "turn_start" });
    }
  } finally {
    await emit({ type: "agent_end", messages: fresh });
  }
  return fresh;
}
