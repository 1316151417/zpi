import { Container, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@zpi-dev/agent";
import { type AssistantMessage, contentText, type Message, type ToolResultMessage } from "@zpi-dev/ai";
import type { AgentSessionEvent } from "@zpi-dev/coding-agent";
import { previewText } from "../preview.ts";
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

function speakerLines(lines: readonly string[], marker: string, width: number) {
  return lines.map((line, index) => truncateToWidth(`${index === 0 ? marker : " "} ${line}`, width));
}

class UserRow extends Text {
  override render(width: number) {
    const lines = speakerLines(super.render(Math.max(1, width - 2)), "❯", width);
    return process.env.NO_COLOR === undefined
      ? lines.map((line) => `\x1b[48;5;236;38;5;255m${line}\x1b[39;49m`)
      : lines;
  }
}

class AnswerRow extends Markdown {
  constructor() {
    super("", 0, 0, markdownTheme);
  }
  override render(width: number) {
    return speakerLines(super.render(Math.max(1, width - 2)), "●", width);
  }
}

class ThoughtRow extends Text {
  private parts: string[] = [];
  private seen = false;
  private elapsed = 0;
  private started?: number;
  private timed = false;
  expanded = false;
  constructor() {
    super("", 2, 0);
  }
  update(message: AssistantMessage, event: string) {
    const blocks = message.content.filter((block) => block.type === "thinking");
    this.seen = blocks.length > 0 || (message.usage.reasoning ?? 0) > 0;
    this.parts = blocks.filter((block) => !block.redacted && block.thinking).map((block) => block.thinking);
    if (event === "reset") {
      this.started = undefined;
      this.timed = false;
      this.elapsed = 0;
    }
    if (event === "thinking_start" && this.started === undefined) {
      this.started = performance.now();
      this.timed = true;
    }
    if (event === "thinking_end" || event === "message_end") this.stop();
    else this.refresh();
  }
  stop() {
    if (this.started !== undefined) this.elapsed += performance.now() - this.started;
    this.started = undefined;
    this.refresh();
  }
  refresh() {
    if (!this.seen) return this.setText("");
    const label =
      this.started !== undefined
        ? "思考中…"
        : this.timed
          ? `已思考 ${Math.round(this.elapsed / 1000)} 秒`
          : "已思考";
    const body = this.expanded ? this.parts.map(safeText).join("\n\n") : "";
    const text = body ? `${label}\n${body}` : label;
    this.setText(`\n${dim(text)}`);
  }
}

class ToolRow extends Text {
  private readonly headline: string;
  private state = "执行中";
  private summary = "";
  private body = "";
  expanded = false;
  constructor(name: string, args: unknown) {
    super("", 2, 0);
    const target = stringField(args, "path") || stringField(args, "command");
    this.headline = accent(safeText(`${name} ${target.split("\n", 1)[0]}`.trim()));
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
    this.summary = previewText(content.split("\n", 1)[0]);
    this.body = [content, safeText(diff)].filter(Boolean).join("\n");
    this.refresh();
  }
  refresh() {
    const line = `${this.headline}  ${dim(this.state)}`;
    this.setText(
      line + (this.expanded && this.body ? `\n${this.body}` : this.summary ? `  ${this.summary}` : ""),
    );
  }
}

export class Transcript extends Container {
  private tools = new Map<string, ToolRow>();
  private thoughts: ThoughtRow[] = [];
  private thought?: ThoughtRow;
  private current?: AnswerRow;
  expanded = false;
  private displayedText = "";

  user(text: string) {
    if (this.children.length) this.addChild(new Spacer(1));
    this.addChild(new UserRow(safeText(text), 0, 0));
  }
  note(text: string) {
    this.addChild(new Text(safeText(text), 1, 0));
  }
  reset(messages: readonly Message[]) {
    this.clear();
    this.tools.clear();
    this.thoughts = [];
    this.beginTurn();
    for (const message of messages) {
      if (message.role === "user" && !message.synthetic)
        this.user(message.userGuide?.text ?? textParts(message.content));
      if (message.role === "assistant") {
        this.beginTurn();
        this.assistant(message, "history");
        for (const part of message.content)
          if (part.type === "toolCall") this.tool(part.id, part.name, part.arguments);
      }
      if (message.role === "toolResult")
        this.tool(message.toolCallId, message.toolName).update(message, message.isError ? "失败" : "完成");
    }
    this.beginTurn();
  }
  beginTurn() {
    this.thought?.stop();
    this.thought = undefined;
    this.current = undefined;
    this.displayedText = "";
  }
  finishTurn(answer: string, elapsedMs?: number) {
    this.thought?.stop();
    // Session events already displayed the answer, including any interim commentary.
    if (answer && !this.displayedText) {
      this.current = new AnswerRow();
      this.current.setText(safeText(answer));
      this.addChild(this.current);
    }
    if (elapsedMs !== undefined && this.current) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(dim(`✻ 用时 ${Math.round(elapsedMs / 1000)} 秒`), 0, 0));
    }
  }
  toggleDetails() {
    this.expanded = !this.expanded;
    for (const row of this.thoughts) {
      row.expanded = this.expanded;
      row.refresh();
    }
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
  private assistant(message: AssistantMessage, event: string) {
    if (!this.thought) {
      this.thought = new ThoughtRow();
      this.thought.expanded = this.expanded;
      this.thoughts.push(this.thought);
      this.addChild(this.thought);
    }
    if (event.startsWith("thinking_") || event === "reset" || event === "message_end" || event === "history")
      this.thought.update(message, event);
    if (event.startsWith("thinking_")) return;
    const text = contentText(message.content, "\n\n");
    if (!this.current) {
      if (!text) return;
      this.addChild(new Spacer(1));
      this.current = new AnswerRow();
      this.addChild(this.current);
    } else if (text === this.displayedText) return;
    this.current.setText(safeText(text));
    this.displayedText = text;
  }
  event(event: AgentSessionEvent) {
    if (event.type === "message_start" && event.message.role === "assistant") this.beginTurn();
    if (
      (event.type === "message_end" ||
        (event.type === "message_update" &&
          (event.assistantMessageEvent.type.startsWith("text_") ||
            event.assistantMessageEvent.type.startsWith("thinking_") ||
            event.assistantMessageEvent.type === "reset"))) &&
      event.message.role === "assistant"
    )
      this.assistant(
        event.message,
        event.type === "message_update" ? event.assistantMessageEvent.type : event.type,
      );
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
      this.displayedText = event.message;
    }
  }
}
