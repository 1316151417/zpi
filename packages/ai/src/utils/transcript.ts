import type {
  AssistantMessage,
  Context,
  JsonObject,
  JsonValue,
  Message,
  Model,
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
