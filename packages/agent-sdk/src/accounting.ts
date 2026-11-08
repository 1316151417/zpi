import type { AssistantMessage } from "@zpi-dev/ai";
import type { ModelRuntime, SessionEntry } from "@zpi-dev/coding-agent";
import { emptyUsage, usage } from "./messages.ts";
import type { ModelUsage } from "./types.ts";

/** A result snapshots session totals; only new requests consume this query's budget. */
export class Accounting {
  turnUsage = emptyUsage();
  cost = 0;
  readonly budget: { cost: number };
  constructor(budget: { cost: number } = { cost: 0 }) {
    this.budget = budget;
  }
  get queryCost(): number {
    return this.budget.cost;
  }
  models: Record<string, ModelUsage> = {};
  private children = new Set<string>();
  restore(entries: SessionEntry[], runtime: ModelRuntime): void {
    for (const entry of entries) {
      if (entry.type === "message" && entry.message.role === "assistant")
        this.assistant(entry.message, runtime, true);
      if (entry.type === "custom" && entry.customType === "sdk.child_usage") {
        const data = entry.data as unknown as {
          agentId: string;
          cost: number;
          models: Record<string, ModelUsage>;
        };
        if (
          !data ||
          typeof data.agentId !== "string" ||
          !Number.isFinite(data.cost) ||
          data.cost < 0 ||
          !data.models ||
          typeof data.models !== "object"
        )
          throw new Error("Invalid SDK child usage record");
        this.child(data.agentId, data.cost, data.models);
      }
    }
  }
  beginTurn(): void {
    this.turnUsage = emptyUsage();
  }
  assistant(message: AssistantMessage, runtime: ModelRuntime | undefined, historical = false): void {
    const u = message.usage;
    if (message.usageAvailable === false) return;
    const value = usage(u);
    if (!historical) {
      for (const key of [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
      ] as const)
        this.turnUsage[key] += value[key];
      this.budget.cost += u.cost.total;
    }
    this.cost += u.cost.total;
    const model = runtime?.getModel(message.provider, message.model);
    const key = `${message.provider}/${message.model}`;
    this.models[key] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: model?.contextWindow ?? 0,
      maxOutputTokens: model?.maxTokens ?? 0,
    };
    const row = this.models[key];
    row.inputTokens += u.input;
    row.outputTokens += u.output;
    row.cacheReadInputTokens += u.cacheRead;
    row.cacheCreationInputTokens += u.cacheWrite;
    row.costUSD += u.cost.total;
  }
  child(id: string, cost: number, models: Record<string, ModelUsage>): boolean {
    if (this.children.has(id)) return false;
    if (
      !Number.isFinite(cost) ||
      cost < 0 ||
      Object.values(models).some(
        (row) =>
          !row ||
          [
            "inputTokens",
            "outputTokens",
            "cacheReadInputTokens",
            "cacheCreationInputTokens",
            "webSearchRequests",
            "costUSD",
            "contextWindow",
            "maxOutputTokens",
          ].some((key) => {
            const value = row[key as keyof ModelUsage];
            return typeof value !== "number" || !Number.isFinite(value) || value < 0;
          }),
      )
    )
      throw new Error("Invalid SDK child usage totals");
    this.children.add(id);
    this.cost += cost;

    for (const [name, value] of Object.entries(models)) {
      const row = this.models[name];
      if (!row) this.models[name] = { ...value };
      else
        for (const key of [
          "inputTokens",
          "outputTokens",
          "cacheReadInputTokens",
          "cacheCreationInputTokens",
          "webSearchRequests",
          "costUSD",
        ] as const)
          row[key] += value[key];
    }
    return true;
  }
}
