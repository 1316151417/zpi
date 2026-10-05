import type { ContextBreakdownItem, JsonObject } from "../types.ts";
/** ZCode's breakdown uses request content character proportions, independent of server token totals. */
export function measureContextBreakdown(payload: JsonObject): ContextBreakdownItem[] {
  const counts = { messages: 0, system_tools: 0, system_prompt: 0, skills: 0, other: 0 };
  const rows = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input)
      ? payload.input
      : [];
  const instructions =
    typeof payload.instructions === "string" ? [{ role: "developer", content: payload.instructions }] : [];
  for (const value of [...instructions, ...rows]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const message = value as JsonObject;
    if (message.role === "system" || message.role === "developer") {
      let text = typeof message.content === "string" ? message.content : "";
      for (const [tag, source] of [
        ["tools", "system_tools"],
        ["skills", "skills"],
      ] as const) {
        text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), (section) => {
          counts[source] += section.length;
          return "";
        });
      }
      counts.system_prompt += text.length;
    } else {
      if (typeof message.content === "string") counts.messages += message.content.length;
      else if (Array.isArray(message.content))
        for (const part of message.content) {
          if (part && typeof part === "object" && !Array.isArray(part) && typeof part.text === "string")
            counts.messages += part.text.length;
        }
      if (message.tool_calls) counts.messages += JSON.stringify(message.tool_calls).length;
      if (message.type === "function_call") counts.messages += String(message.arguments ?? "").length;
      if (message.type === "function_call_output") counts.messages += String(message.output ?? "").length;
      if (typeof message.reasoning_content === "string") counts.messages += message.reasoning_content.length;
    }
  }
  if (payload.tools) counts.system_tools += JSON.stringify(payload.tools).length;
  return Object.entries(counts).map(([source, chars]) => ({
    source: source as ContextBreakdownItem["source"],
    chars,
  }));
}
