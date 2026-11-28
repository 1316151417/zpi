import { basename, dirname } from "node:path";
import { type Container, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@zpi-dev/agent";
import type { AssistantMessage, Message, ToolResultMessage } from "@zpi-dev/ai";
import type { AgentSessionEvent } from "@zpi-dev/coding-agent";
import {
  bold,
  dim,
  failure,
  foreground,
  italic,
  markdownTheme,
  muted,
  safeText,
  success,
  thinking,
  toolBackground,
  userBackground,
} from "./theme.ts";

type Output = Pick<AgentToolResult, "content" | "details"> | ToolResultMessage;
function field(object: unknown, key: string): unknown {
  return object && typeof object === "object" ? Reflect.get(object, key) : undefined;
}
function stringField(object: unknown, key: string) {
  const value = field(object, key);
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

// Preserve pi-tui's token and block caches when an event only updated a different part.
class MessageRow extends Markdown {
  private source: string;
  readonly kind: "user" | "answer" | "thought";
  constructor(kind: MessageRow["kind"], source: string) {
    const user = kind === "user";
    super(
      source,
      1,
      user ? 1 : 0,
      markdownTheme,
      user
        ? { color: foreground, bgColor: userBackground }
        : kind === "thought"
          ? { color: thinking, italic: true }
          : undefined,
      { transform: safeText, preserveOrderedListMarkers: user, preserveBackslashEscapes: user },
    );
    this.kind = kind;
    this.source = source;
  }
  update(source: string) {
    if (source !== this.source) this.setText(source);
    this.source = source;
  }
  override render(width: number) {
    const lines = super.render(width);
    if (process.env.NO_COLOR === undefined || !lines.length) return lines;
    const label = this.kind === "user" ? "你" : this.kind === "thought" ? "思考" : "";
    return label ? [truncateToWidth(` ${label}`, width), ...lines] : lines;
  }
}

class ToolRow {
  state: keyof typeof toolBackground = "pending";
  private name = "";
  private target = "";
  private range = "";
  private writeContent = "";
  private output = "";
  private diff = "";
  private cached?: { width: number; expanded: boolean; state: ToolRow["state"]; lines: string[] };
  private heading = new Text("", 0, 0);
  private result = new Text("", 0, 0);
  readonly id: string;
  constructor(id: string, name: string, args?: unknown) {
    this.id = id;
    this.input(name, args);
  }
  input(name: string, args?: unknown) {
    if (name && name !== this.name) {
      this.name = safeText(name);
      this.cached = undefined;
    }
    if (!args) return;
    this.cached = undefined;
    this.target = safeText(stringField(args, this.name === "bash" ? "command" : "path"));
    if (this.name === "write") this.writeContent = stringField(args, "content");
    if (this.name === "read") {
      const offset = field(args, "offset");
      const limit = field(args, "limit");
      const start = typeof offset === "number" ? offset : 1;
      this.range =
        typeof limit === "number"
          ? `:${start}-${start + limit - 1}`
          : typeof offset === "number"
            ? `:${start}`
            : "";
    }
  }
  update(output: Output, state: ToolRow["state"]) {
    this.state = state;
    this.cached = undefined;
    this.output = safeText(textParts(output.content)).trimEnd();
    const change = field(output.details, "fileChange");
    this.diff = safeText(
      stringField(output.details, "diff") ||
        stringField(change, "patch") ||
        stringField(output.details, "patch") ||
        stringField(change, "reason") ||
        stringField(change, "patchFile"),
    );
  }
  invalidate() {
    this.cached = undefined;
    this.heading.invalidate();
    this.result.invalidate();
  }
  lines(width: number, expanded: boolean) {
    if (this.cached?.width === width && this.cached.expanded === expanded && this.cached.state === this.state)
      return this.cached.lines;
    const failed = this.state === "error";
    const skill = this.name === "read" && !expanded && !failed && basename(this.target) === "SKILL.md";
    const title =
      this.name === "bash"
        ? foreground(bold(`$ ${this.target || "…"}`))
        : skill
          ? `${bold("[skill]")} ${basename(dirname(this.target))}`
          : foreground(bold(this.name)) +
            (this.target ? ` ${markdownTheme.code(this.target)}${this.range}` : "");
    this.heading.setText(title);
    const innerWidth = Math.max(1, width - 2);
    const rows = [...this.heading.render(innerWidth)];
    let content = this.output;
    let limit = expanded ? Infinity : 10;
    if (failed) content = failure("失败") + (content ? ` · ${content}` : "");
    else if (this.name === "read" && !expanded) content = "";
    else if (this.name === "write" && this.writeContent) {
      content = safeText(this.writeContent).trimEnd();
      if (expanded) content = [content, this.output, this.diff].filter(Boolean).join("\n\n");
    } else if (this.name === "edit" && this.diff) {
      content = this.diff
        .split("\n")
        .map((line) => (line.startsWith("+") ? success(line) : line.startsWith("-") ? failure(line) : line))
        .join("\n");
      if (expanded && this.output) content += `\n\n${this.output}`;
      limit = Infinity;
    } else if (this.diff) content = [content, this.diff].filter(Boolean).join("\n\n");
    if (content) {
      const tail = this.name === "bash" && !failed;
      if (tail && !expanded) limit = 5;
      this.result.setText(content);
      const lines = this.result.render(innerWidth);
      const hidden = Math.max(0, lines.length - limit);
      const preview = hidden ? (tail ? lines.slice(-limit) : lines.slice(0, limit)) : lines;
      const hint = hidden
        ? new Text(dim(`… ${tail ? "前面" : "还有"} ${hidden} 行（Ctrl+O 展开）`), 0, 0).render(innerWidth)
        : [];
      rows.push("");
      if (tail) for (const line of hint) rows.push(line);
      for (const line of preview) rows.push(muted(line));
      if (!tail) for (const line of hint) rows.push(line);
    }
    const bg = toolBackground[this.state];
    const lines = ["", ...rows, ""].map((line) => bg(truncateToWidth(` ${line}`, width, "", true)));
    this.cached = { width, expanded, state: this.state, lines };
    return lines;
  }
}

type Row = MessageRow | ToolRow | Text | Container;
class AssistantRows {
  rows: Row[] = [];
}

export class Transcript {
  private rows: (Row | AssistantRows)[] = [];
  private tools = new Map<string, ToolRow>();
  private current?: AssistantRows;
  private hasAnswer = false;
  private commandResult = false;
  private toolsExpanded = false;
  private thinkingHidden: boolean;
  private thinkingLabel = new Text(thinking(italic("思考…")), 1, 0);
  constructor(thinkingHidden = false) {
    this.thinkingHidden = thinkingHidden;
  }

  user(text: string) {
    this.rows.push(new MessageRow("user", text));
  }
  addPanel(panel: Container) {
    this.rows.push(panel);
  }
  note(text: string, kind: "info" | "error" = "info") {
    this.rows.push(
      new Text(kind === "error" ? failure(`✕  ${safeText(text)}`) : dim(`ℹ  ${safeText(text)}`), 1, 0),
    );
  }
  reset(messages: readonly Message[]) {
    this.rows = [];
    this.tools.clear();
    this.beginTurn();
    for (const message of messages) {
      if (message.role === "user" && !message.synthetic)
        this.user(message.userGuide?.text ?? textParts(message.content));
      if (message.role === "assistant") {
        this.beginTurn();
        this.assistant(message);
      }
      if (message.role === "toolResult")
        this.tool(message.toolCallId, message.toolName).update(
          message,
          message.isError ? "error" : "success",
        );
    }
    this.beginTurn();
  }
  beginTurn() {
    this.current = undefined;
    this.hasAnswer = false;
    this.commandResult = false;
  }
  finishTurn(answer: string) {
    if (answer && !this.hasAnswer && !this.commandResult) this.rows.push(new MessageRow("answer", answer));
  }
  toggleDetails() {
    this.toolsExpanded = !this.toolsExpanded;
  }
  toggleThinking() {
    this.thinkingHidden = !this.thinkingHidden;
    return this.thinkingHidden;
  }
  invalidate() {
    this.thinkingLabel.invalidate();
    for (const entry of this.rows) {
      if (entry instanceof AssistantRows) for (const row of entry.rows) row.invalidate();
      else entry.invalidate();
    }
  }
  render(width: number) {
    const result: string[] = [];
    for (const entry of this.rows) {
      let previous: Row | undefined;
      for (const row of entry instanceof AssistantRows ? entry.rows : [entry]) {
        const lines =
          row instanceof ToolRow
            ? row.lines(width, this.toolsExpanded)
            : this.thinkingHidden && row instanceof MessageRow && row.kind === "thought"
              ? this.thinkingLabel.render(width)
              : row.render(width);
        if (!lines.length) continue;
        const adjacentAnswer =
          row instanceof MessageRow &&
          row.kind === "answer" &&
          previous instanceof MessageRow &&
          previous.kind === "answer";
        if (result.length && !adjacentAnswer) result.push("");
        for (const line of lines) result.push(line);
        previous = row;
      }
    }
    return result;
  }
  private tool(id: string, name: string, args?: unknown) {
    let row = this.tools.get(id);
    if (!row) {
      row = new ToolRow(id, name, args);
      this.tools.set(id, row);
      this.rows.push(row);
    } else row.input(name, args);
    return row;
  }
  private assistant(message: AssistantMessage, reset = false) {
    if (!this.current) {
      this.current = new AssistantRows();
      this.rows.push(this.current);
    }
    if (reset) {
      this.hasAnswer = false;
      for (const row of this.current.rows)
        if (row instanceof ToolRow && this.tools.get(row.id) === row) this.tools.delete(row.id);
    }
    const previous = reset ? [] : this.current.rows;
    const rows: Row[] = [];
    const append = (kind: "answer" | "thought", text: string) => {
      const old = previous[rows.length];
      if (old instanceof MessageRow && old.kind === kind) {
        old.update(text);
        rows.push(old);
      } else rows.push(new MessageRow(kind, text));
    };
    for (let i = 0; i < message.content.length; i++) {
      const part = message.content[i];
      if (part.type === "text" && part.text.trim()) {
        append("answer", part.text.trim());
        this.hasAnswer = true;
      } else if (part.type === "thinking") {
        const texts = [];
        for (; i < message.content.length; i++) {
          const thought = message.content[i];
          if (thought.type !== "thinking") break;
          if (!thought.redacted && thought.thinking.trim()) texts.push(thought.thinking.trim());
        }
        i--;
        if (texts.length) {
          append("thought", texts.join("\n\n"));
        }
      } else if (part.type === "toolCall") {
        const row = this.tools.get(part.id) ?? new ToolRow(part.id, part.name);
        if (part.id) this.tools.set(part.id, row);
        if (row !== previous[rows.length]) {
          const standalone = this.rows.indexOf(row);
          if (standalone !== -1) this.rows.splice(standalone, 1);
        }
        row.input(part.name, part.arguments);
        rows.push(row);
      }
    }
    this.current.rows = rows;
  }
  event(event: AgentSessionEvent) {
    if (event.type === "message_start" && event.message.role === "assistant") this.beginTurn();
    if (event.type === "message_end" && event.message.role === "assistant") this.assistant(event.message);
    if (event.type === "message_update" && event.message.role === "assistant") {
      const update = event.assistantMessageEvent;
      if ("contentIndex" in update || update.type === "reset")
        this.assistant(event.message, update.type === "reset");
    }
    if (event.type === "tool_execution_start")
      this.tool(event.toolCallId, event.toolName, event.args).state = "pending";
    if (event.type === "tool_execution_update")
      this.tool(event.toolCallId, event.toolName, event.args).update(event.partialResult, "pending");
    if (event.type === "tool_execution_end")
      this.tool(event.toolCallId, event.toolName).update(event.result, event.isError ? "error" : "success");
    if (event.type === "model_retry" && event.status)
      this.note(
        `模型重试 ${event.status.attempt}/${event.status.maxRetries}，等待 ${Math.ceil(event.status.retryDelayMs / 1000)} 秒`,
      );
    if (event.type === "compaction" && event.status === "running") this.note("正在压缩上下文…");
    if (event.type === "command_result") {
      this.note(event.message);
      this.commandResult = true;
    }
  }
}
