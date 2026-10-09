import type { Message, Model, ToolCall } from "../types.ts";

/** Replay a portable local transcript; provider signatures only belong to their original model. */
export function transformMessages(
  messages: readonly Message[],
  model: Model,
  normalizeId?: (id: string) => string,
): Message[] {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  const result: Message[] = [];
  const pending = new Map<string, ToolCall>();
  const interrupted = () => {
    for (const call of pending.values())
      result.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "Tool execution was interrupted." }],
        isError: true,
        timestamp: 0,
      });
    pending.clear();
  };
  for (const message of messages) {
    if (message.role === "toolResult") {
      const id = ids.get(message.toolCallId);
      if (!id || !pending.has(id)) continue;
      pending.delete(id);
      result.push({ ...message, toolCallId: id });
      continue;
    }
    if (message.role === "assistant" || message.role === "user") interrupted();
    if (message.role !== "assistant") {
      result.push(message);
      continue;
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    const same =
      message.api === model.api && message.provider === model.provider && message.model === model.id;
    const content = message.content.flatMap((block): typeof message.content => {
      if (block.type === "thinking")
        return same
          ? [block]
          : !block.redacted && block.thinking.trim()
            ? [{ type: "text", text: block.thinking }]
            : [];
      if (block.type === "text") return [same ? block : { type: "text", text: block.text }];
      const [originalCallId, itemId] = block.id.split("|");
      const base =
        (normalizeId
          ? normalizeId(originalCallId)
          : originalCallId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56)) || "call";
      let callId = base;
      let suffix = 0;
      while (used.has(callId)) callId = `${base.slice(0, 56)}_${++suffix}`;
      used.add(callId);
      const id = same && model.api === "openai-responses" && itemId ? `${callId}|${itemId}` : callId;
      ids.set(block.id, id);
      const call: ToolCall = {
        type: "toolCall",
        id,
        name: block.name,
        arguments: block.arguments,
        ...(same && block.namespace ? { namespace: block.namespace } : {}),
      };
      pending.set(id, call);
      return [call];
    });
    if (content.length) result.push({ ...message, content });
  }
  interrupted();
  return result;
}
