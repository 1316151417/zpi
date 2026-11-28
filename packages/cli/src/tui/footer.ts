import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Message } from "@zpi-dev/ai";
import type { CliHost } from "../host/index.ts";
import { dim, failure, resourceTitle, safeText } from "./theme.ts";

function compact(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const millions = tokens >= 1_000_000;
  const value = tokens / (millions ? 1_000_000 : 1000);
  return `${value.toFixed(value < 10 ? 1 : 0)}${millions ? "M" : "k"}`;
}

export class Footer {
  directory: string;
  branch = "";
  name = "";
  model = "";
  mode = "";
  draft = "";
  providerCount = 0;
  subscription = false;
  window?: number;
  private cost = 0;
  private context?: ReturnType<CliHost["getContext"]>;
  private usage?: ReturnType<CliHost["getPerformance"]>;

  constructor(directory: string) {
    this.directory = directory;
  }
  recordCost(message: Message) {
    if (message.role === "assistant") {
      const amount = message.usage.cost?.total;
      if (Number.isFinite(amount) && amount > 0) this.cost += amount;
    }
  }
  restoreCost(messages: Iterable<Message>) {
    this.cost = 0;
    for (const message of messages) this.recordCost(message);
  }
  refresh(host: Pick<CliHost, "getContext" | "getPerformance">) {
    this.context = host.getContext();
    this.usage = host.getPerformance();
  }
  invalidate() {}
  render(width: number) {
    const path = this.directory + (this.branch && ` (${this.branch})`) + (this.name && ` • ${this.name}`);
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheHitRate } = this.usage ?? {};
    const usage = this.context;
    const window = usage?.contextWindow ?? this.window;
    const percentage = usage?.percent;
    const percentLabel = percentage === null ? "?" : `${(percentage ?? 0).toFixed(1)}%`;
    const context =
      window && `${percentLabel}/${compact(window)}${usage?.compaction?.enabled ? " (auto)" : ""}`;
    const contextColor = (percentage ?? 0) > 90 ? failure : (percentage ?? 0) > 70 ? resourceTitle : dim;
    const stats = [
      inputTokens && `↑${compact(inputTokens)}`,
      outputTokens && `↓${compact(outputTokens)}`,
      cacheReadTokens && `R${compact(cacheReadTokens)}`,
      cacheWriteTokens && `W${compact(cacheWriteTokens)}`,
      (cacheReadTokens || cacheWriteTokens) &&
        cacheHitRate !== undefined &&
        `CH${(100 * cacheHitRate).toFixed(1)}%`,
      (this.cost > 0 || this.subscription) && `$${this.cost.toFixed(3)}${this.subscription ? " (sub)" : ""}`,
    ]
      .filter(Boolean)
      .join(" ");
    const left = truncateToWidth(
      [stats && dim(stats), context && contextColor(context), this.draft && dim(this.draft)]
        .filter(Boolean)
        .join(" "),
      width,
      "...",
    );
    const slash = this.model.indexOf("/");
    const id = slash < 0 ? this.model : this.model.slice(slash + 1);
    const suffix = this.mode && ` • ${this.mode}`;
    const short = id + suffix;
    const qualified =
      this.providerCount > 1 && slash >= 0 ? `(${this.model.slice(0, slash)}) ${short}` : short;
    const room = Math.max(0, width - visibleWidth(left) - 2);
    const right = visibleWidth(qualified) <= room ? qualified : truncateToWidth(short, room, "");
    const gap = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
    return [
      dim(truncateToWidth(safeText(path).replaceAll("\n", " "), width, "...")),
      left + gap + dim(right),
    ];
  }
}
