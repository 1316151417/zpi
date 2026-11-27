import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@zpi-dev/agent";
import type { AssistantMessage, Message, ToolResultMessage } from "@zpi-dev/ai";
import type { AgentSessionEvent } from "@zpi-dev/coding-agent";
import { accent, dim, markdownTheme, safeText } from "./theme.ts";

type Output = Pick<AgentToolResult, "content" | "details"> | ToolResultMessage;
function stringField(object: unknown, field: string) {
  const value = object && typeof object === "object" && Reflect.get(object, field);
  return typeof value === "string" ? value : "";
}
function textParts(content: (Message & { role: "user" | "assistant" | "toolResult" })["content"]) {
  return typeof content === "string"
    ? content
    : content
        .map((part) => (part.type === "text" ? part.text : part.type === "image" ? "[图片]" : ""))
        .filter(Boolean)
        .join("\n");
}

class ToolRow extends Text {
  name: string;
  args: unknown;
  private state = "执行中";
  private summary = "";
  private body = "";
  expanded = false;
  constructor(name: string, args: unknown) {
    super("", 2, 0);
    this.name = name;
    this.args = args;
    this.refresh();
  }
  update(output: Output, state: string) {
    this.state = state;
    const detail = output.details;
    const change = detail && typeof detail === "object" ? Reflect.get(detail, "fileChange") : undefined;
    const diff =
      stringField(change, "patch") ||
      stringField(detail, "diff") ||
      stringField(change, "reason") ||
      stringField(change, "patchFile");
    const content = safeText(textParts(output.content)).trim();
    this.summary = content.split("\n", 1)[0].slice(0, 100);
    this.body = [content, safeText(diff)].filter(Boolean).join("\n");
    this.refresh();
  }
  refresh() {
    const target = stringField(this.args, "path") || stringField(this.args, "command");
    const headline = `${this.name} ${target.split("\n", 1)[0]}`.trim();
    const line = `${accent(safeText(headline))}  ${dim(this.state)}`;
    this.setText(
      line + (this.expanded && this.body ? `\n${this.body}` : this.summary ? `  ${this.summary}` : ""),
    );
  }
}

export class Transcript extends Container {
  private tools = new Map<string, ToolRow>();
  private current?: Markdown;
  expanded = false;
  lastAnswer = "";

  user(text: string) {
    this.addChild(new Text(accent("› ") + safeText(text), 1, 0));
  }
  note(text: string) {
    this.addChild(new Text(safeText(text), 1, 0));
  }
  reset(messages: readonly Message[]) {
    this.clear();
    this.tools.clear();
    this.beginTurn();
    for (const message of messages) {
      if (message.role === "user" && !message.synthetic)
        this.user(message.userGuide?.text ?? textParts(message.content));
      if (message.role === "assistant") {
        this.current = undefined;
        this.assistant(message);
        for (const part of message.content)
          if (part.type === "toolCall") this.tool(part.id, part.name, part.arguments);
      }
      if (message.role === "toolResult")
        this.tool(message.toolCallId, message.toolName).update(message, message.isError ? "失败" : "完成");
    }
    this.beginTurn();
  }
  beginTurn() {
    this.current = undefined;
    this.lastAnswer = "";
  }
  toggleDetails() {
    this.expanded = !this.expanded;
    for (const row of this.tools.values()) {
      row.expanded = this.expanded;
      row.refresh();
    }
  }
  private tool(id: string, name: string, args?: unknown) {
    let row = this.tools.get(id);
    if (!row) {
      row = new ToolRow(name, args);
      row.expanded = this.expanded;
      this.tools.set(id, row);
      this.addChild(row);
    }
    return row;
  }
  private assistant(message: AssistantMessage) {
    const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    if (!text) return;
    if (!this.current) {
      this.current = new Markdown("", 1, 0, markdownTheme);
      this.addChild(this.current);
    }
    this.current.setText(safeText(text));
    this.lastAnswer = text;
  }
  event(event: AgentSessionEvent) {
    if (event.type === "message_start" && event.message.role === "assistant") this.current = undefined;
    if (
      (event.type === "message_update" || event.type === "message_end") &&
      event.message.role === "assistant"
    )
      this.assistant(event.message);
    if (event.type === "tool_execution_start") this.tool(event.toolCallId, event.toolName, event.args);
    if (event.type === "tool_execution_update")
      this.tool(event.toolCallId, event.toolName, event.args).update(event.partialResult, "执行中");
    if (event.type === "tool_execution_end")
      this.tool(event.toolCallId, event.toolName).update(event.result, event.isError ? "失败" : "完成");
    if (event.type === "model_retry" && event.status)
      this.note(
        `模型重试 ${event.status.attempt}/${event.status.maxRetries}，等待 ${Math.ceil(event.status.retryDelayMs / 1000)} 秒`,
      );
    if (event.type === "compaction" && event.status === "running") this.note("正在压缩上下文…");
    if (event.type === "command_result") {
      this.note(event.message);
      this.lastAnswer = event.message;
    }
  }
}
