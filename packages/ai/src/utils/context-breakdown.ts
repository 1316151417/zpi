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
  const system = payload.system ? [{ role: "system", content: payload.system }] : [];
  const textContent = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        if (block.type === "text") return block.text ?? "";
        if (block.type === "thinking") return block.thinking ?? "";
        if (block.type === "tool_use") return JSON.stringify(block.input ?? {});
        if (block.type === "tool_result") return textContent(block.content);
        return "";
      })
      .join("");
  };
  for (const value of [...system, ...instructions, ...rows]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const message = value as JsonObject;
    if (message.role === "system" || message.role === "developer") {
      let text = textContent(message.content);
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
      counts.messages += textContent(message.content).length;
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
