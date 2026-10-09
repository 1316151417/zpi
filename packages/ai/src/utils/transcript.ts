import type {
  AssistantMessage,
  Context,
  JsonObject,
  JsonValue,
  Message,
  Model,
  SystemMessage,
  Tool,
  TranscriptContext,
} from "../types.ts";
export function normalizeContext(context: Context): TranscriptContext {
  const head: Message[] =
    context.systemPrompt || context.tools?.length
      ? [{ role: "system", content: context.systemPrompt ?? "", toolsAdded: context.tools, timestamp: 0 }]
      : [];
  return { messages: [...head, ...context.messages] } as TranscriptContext;
}
export function contentText(
  content: string | readonly { type: string; text?: string }[],
  separator = "\n",
): string {
  return typeof content === "string"
    ? content
    : content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join(separator);
}
export function getCurrentSystemPrompt(messages: readonly { role: string }[]): string {
  const parts: string[] = [];
  const sections = new Map<string, string>();
  for (const item of messages) {
    if (item.role !== "system") continue;
    const m = item as Extract<Message, { role: "system" }>;
    const text = typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("\n");
    if (text) parts.push(text);
    for (const [key, value] of Object.entries(m.sections ?? {})) {
      if (value === null) sections.delete(key);
      else sections.set(key, value);
    }
  }
  return [...parts, ...sections.values()].join("\n\n");
}
export function getCurrentTools(messages: readonly { role: string }[]): Tool[] {
  const tools = new Map<string, Tool>();
  for (const item of messages) {
    if (item.role !== "system") continue;
    const m = item as Extract<Message, { role: "system" }>;
    for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
    for (const t of m.toolsAdded ?? []) tools.set(t.name, t);
  }
  return [...tools.values()];
}
export function toToolDeclaration(tool: Tool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters)),
    ...(tool.constrainedSampling ? { constrainedSampling: { ...tool.constrainedSampling } } : {}),
  };
}
export function emptyAssistant(model: Model): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason: "stop",
    usageAvailable: false,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
export function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value)).every((v) => isJsonValue(v, seen));
  seen.delete(value);
  return valid;
}
export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}
export function assertSupportedOptions(value: object, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${label}: unsupported option ${key}`);
}

export type TranscriptMessages = readonly { role: string }[];

function isSystemMessage(message: { role: string }): message is SystemMessage {
  return message.role === "system";
}

/** Return the leading system message, if the transcript starts with one. */
export function getInitialSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
  const first = messages[0];
  return first && isSystemMessage(first) ? first : undefined;
}

/**
 * Replay every system message into one leading system message holding the current
 * prompt and tools. Later `content` is appended to the base prompt, `sections` are
 * patched by name, and tools are resolved with {@link getCurrentTools}.
 */
export function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
  const content: string[] = [];
  const sections = new Map<string, string>();
  let timestamp: number | undefined;
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    timestamp ??= message.timestamp;
    const text = contentText(message.content);
    if (text.length > 0) content.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  const tools = getCurrentTools(messages);
  if (timestamp === undefined && tools.length === 0) return undefined;
  return {
    role: "system",
    content: content.join("\n\n"),
    ...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
    ...(tools.length > 0 ? { toolsAdded: tools } : {}),
    timestamp: timestamp ?? 0,
  };
}

/**
 * Rebuild the transcript for APIs without mid-conversation system messages: the replayed
 * system message leads, and every later system message is dropped.
 */
export function collapseSystemMessages(context: TranscriptContext): TranscriptContext {
  const head = getCurrentSystemMessage(context.messages);
  const messages = context.messages.filter((message) => message.role !== "system");
  return { messages: head ? [head, ...messages] : messages } as TranscriptContext;
}

/** Keep later system messages in place when the model accepts them; otherwise collapse them. */
export function resolveTranscript(
  context: TranscriptContext,
  supportsMidConvoSystemMessages: boolean | undefined,
): TranscriptContext {
  return supportsMidConvoSystemMessages ? context : collapseSystemMessages(context);
}

export function getDeclaredTools(messages: TranscriptMessages): Tool[] {
  const definitions = new Map<string, Tool>();
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    for (const tool of message.toolsAdded ?? []) definitions.set(tool.name, tool);
  }
  return [...definitions.values()];
}

/**
 * Whether a tool name was declared twice with different definitions. Transports that
 * reference tools by name (Anthropic `tool_addition`/`tool_removal`) cannot express that.
 */
export function hasToolRedefinitions(messages: TranscriptMessages): boolean {
  const declared = new Map<string, Tool>();
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    for (const tool of message.toolsAdded ?? []) {
      const previous = declared.get(tool.name);
      if (
        previous !== undefined &&
        JSON.stringify(toToolDeclaration(previous)) !== JSON.stringify(toToolDeclaration(tool))
      )
        return true;
      declared.set(tool.name, tool);
    }
  }
  return false;
}
