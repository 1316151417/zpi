import { Check } from "typebox/value";
import type { AgentLoopConfig, AgentMessage } from "zpi-agent";
import { contentText } from "zpi-ai";
import {
  type HookEvent,
  type HookExecution,
  type HookRegistration,
  HookRunner,
  hookEvents,
  maxHookContextChars,
} from "./hooks.ts";

/** Bridges lifecycle decisions to the loop; the runner never owns session history. */
export class SessionHooks {
  readonly runner: HookRunner;
  private started = false;
  private startMessages: AgentMessage[] = [];
  private pending = new Map<HookEvent, Map<number, string[]>>();
  private callOrder = new Map<string, number>();
  private continuations = 0;
  private context: { sessionId: string; cwd: string; source: "startup" | "resume" };
  constructor(
    context: { sessionId: string; cwd: string; source: "startup" | "resume" },
    hooks: readonly (HookRegistration & { pluginId?: string })[],
    observe: (event: HookExecution) => void,
  ) {
    this.context = context;
    this.runner = new HookRunner(hooks, observe);
  }
  beginRun(): void {
    this.pending.clear();
    this.callOrder.clear();
    this.continuations = 0;
  }
  async preparePrompt(prompt: string, signal?: AbortSignal): Promise<AgentMessage[]> {
    if (!this.started) {
      const result = await this.runner.run({ ...this.context, event: "SessionStart" }, signal);
      this.startMessages = contextMessages("SessionStart", result.additionalContexts);
      this.started = true;
    }
    const result = await this.runner.run({ ...this.context, event: "UserPromptSubmit", prompt }, signal);
    if (result.block) throw new Error(result.reason ?? "Input blocked by hook");
    const messages = [
      ...this.startMessages,
      ...contextMessages("UserPromptSubmit", result.additionalContexts),
    ];
    this.startMessages = [];
    return messages;
  }
  drainMessages(): AgentMessage[] {
    const messages = [...this.pending]
      .sort(([a], [b]) => hookEvents.indexOf(a) - hookEvents.indexOf(b))
      .flatMap(([event, entries]) =>
        contextMessages(
          event,
          [...entries].sort(([a], [b]) => a - b).flatMap(([, contexts]) => contexts),
        ),
      );
    this.pending.clear();
    this.callOrder.clear();
    return messages;
  }
  beforeToolCall: NonNullable<AgentLoopConfig["beforeToolCall"]> = async (call, signal) => {
    this.continuations = 0;
    this.callOrder.set(call.toolCall.id, this.callOrder.size);
    const result = await this.runner.run(
      {
        ...this.context,
        event: "PreToolUse",
        toolCallId: call.toolCall.id,
        toolName: call.toolCall.name,
        toolInput: call.args,
      },
      signal,
      (input) => {
        const tool = call.context.tools?.find((tool) => tool.name === call.toolCall.name);
        const args = tool?.prepareArguments ? tool.prepareArguments(structuredClone(input)) : input;
        if (!tool || !Check(tool.parameters, args)) throw new Error("Invalid hook tool input");
        return args;
      },
    );
    this.enqueue("PreToolUse", call.toolCall.id, result.additionalContexts);
    return { block: result.block, reason: result.reason, args: result.updatedInput };
  };
  afterToolCall: NonNullable<AgentLoopConfig["afterToolCall"]> = async (call, signal) => {
    const event = call.isError ? "PostToolUseFailure" : "PostToolUse";
    try {
      const result = await this.runner.run(
        {
          ...this.context,
          event,
          toolCallId: call.toolCall.id,
          toolName: call.toolCall.name,
          toolInput: call.args,
          toolResult: call.result,
        },
        signal,
      );
      this.enqueue(event, call.toolCall.id, result.additionalContexts);
    } catch (error) {
      // 工具已经完成；取消 hook 只能结束等待，不能抹掉已执行结果和文件变更事实。
      if (!signal?.aborted) throw error;
    }
    return undefined;
  };
  beforeStop: NonNullable<AgentLoopConfig["beforeStop"]> = async (message, signal) => {
    if (this.continuations >= 3) return;
    const result = await this.runner.run(
      {
        ...this.context,
        event: "Stop",
        response: contentText(message.content, ""),
        stopHookActive: this.continuations > 0,
      },
      signal,
    );
    if (!result.additionalContexts.length) return;
    this.continuations++;
    return contextMessages("Stop", result.additionalContexts);
  };
  private enqueue(event: HookEvent, toolCallId: string, contexts: string[]): void {
    if (!contexts.length) return;
    const entries = this.pending.get(event) ?? new Map<number, string[]>();
    entries.set(this.callOrder.get(toolCallId) ?? 0, contexts);
    this.pending.set(event, entries);
  }
}

function contextMessages(event: HookEvent, contexts: string[]): AgentMessage[] {
  return contexts.length
    ? [
        {
          role: "user",
          synthetic: true,
          content: `<hook_context event="${event}">\n${contexts.join("\n\n").slice(0, maxHookContextChars)}\n</hook_context>`,
          timestamp: Date.now(),
        },
      ]
    : [];
}
